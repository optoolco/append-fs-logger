'use strict'

const fs = require('fs')
const util = require('util')
const path = require('path')
const assert = require('assert')
const stream = require('stream')

const { wrapf, WError } = require('./error.js')
const { resultify } = require('./resultify.js')

const readFile = resultify(fs.readFile)
const pipeline = resultify(stream.pipeline)
const unlink = resultify(fs.unlink)
const open = resultify(fs.open)
const mkdir = resultify(fs.mkdir)
const rename = resultify(fs.rename)
const close = resultify(fs.close)
const write = resultify(fs.write)

const MAX_LOG_FILE_SIZE = 32 * 1024 * 1024
const MAX_LOG_LINE_SIZE = 32 * 1024
const MAX_LOG_LINES = 4096
const EMPTY_OBJECT = {}

const hostname = require('os').hostname()

class OpenFailError extends WError {
  constructor (message, cause, info) {
    super(message, cause, info)

    this.shouldBail = false
    this.code = cause.code
    this.syscall = cause.syscall
    this.path = cause.path
  }
}

class LogLine {
  constructor (name, level, msg, info, time, truncated) {
    this.name = name
    this.hostname = hostname
    this.pid = process.pid
    this.level = level
    this.msg = msg
    /** @Raynos TODO: millisecond or string ? */
    this.time = new Date(time).toISOString()
    this.v = 1

    this.fields = info
    this.truncated = truncated

    /** @Raynos TODO: this.src; this.component; ? */
  }
}

class AppendOnlyFSLogger {
  constructor (productName, options) {
    assert(options.fileName, 'options.fileName required')

    this.logFileLocation = options.fileName
    this.productName = productName
    this.onError = options.onError || warnOnError

    this.fd = null

    // Number of lines in the file.
    this.lines = 0
    // Current size of the file after writing
    this.size = 0
    // Total cumulative bytes written by logger to fd.
    this.bytesWritten = 0
    // Internal fs.write() counter for testing
    this._writeCalled = 0
    // Tracking where all the new lines are in the file.
    this.newLineOffsets = []

    // The current pending flush task
    this.pendingFlush = null
    // Pending loglines to be written
    this.pendingWrites = []

    this.hasOpened = false
  }

  async open () {
    if (this.fd) {
      return { err: new Error('Cannot open twice()') }
    }

    const dirname = path.dirname(this.logFileLocation)
    const { err: mkdirErr } = await mkdir(dirname, {
      recursive: true
    })
    if (mkdirErr) {
      const err = OpenFailError.wrap(
        'Could not mkdir for log file', mkdirErr, {
          fileName: this.logFileLocation,
          dirname: dirname,
          productName: this.productName
        }
      )
      return { err: err }
    }

    const { err: readErr, data: buf } =
      await readFile(this.logFileLocation)
    if (readErr && readErr.code !== 'ENOENT') {
      const err = OpenFailError.wrap(
        'Could not read old file', readErr, {
          fileName: this.logFileLocation,
          productName: this.productName
        }
      )

      return { err: err }
    }

    /**
     * We want to keep track of the size of the file and
     * the number of lines that it contains.
     */
    if (Buffer.isBuffer(buf)) {
      this.size = buf.length

      this.newLineOffsets.length = 0

      const newLineByte = '\n'.charCodeAt(0)
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === newLineByte) {
          this.newLineOffsets.push(i)
        }
      }

      this.lines = this.newLineOffsets.length
    }

    const { err: openErr, data: fd } =
      await open(this.logFileLocation, 'a+')
    if (openErr) {
      const err = OpenFailError.wrap(
        'Could not open log file', openErr, {
          fileName: this.logFileLocation,
          productName: this.productName
        }
      )
      if (openErr.code === 'EACCES') {
        err.shouldBail = true
      }

      return { err: err }
    }

    this.hasOpened = true
    this.fd = fd
    return {}
  }

  _write (level, msg, info, time) {
    let str = JSON.stringify(new LogLine(
      this.productName, level, msg, info || EMPTY_OBJECT, time
    ))

    if (str.length > MAX_LOG_LINE_SIZE) {
      const truncLevel = level === 'info' ? 'warn' : level

      str = JSON.stringify(new LogLine(
        this.productName, truncLevel, msg, {
          isTruncated: true
        }, time, str.slice(0, MAX_LOG_LINE_SIZE - 3) + '...'
      ))
    }

    this.pendingWrites.push(str)
    return this.flush()
  }

  async flush () {
    if (this.pendingFlush) await this.pendingFlush
    if (this.pendingWrites.length === 0) {
      return this.pendingFlush
    }

    this.pendingFlush = this._flush()
    const r = await this.pendingFlush
    this.pendingFlush = null

    if (r.err) {
      this.onError(r.err)
    }
    return null
  }

  async _flush () {
    const pendingWrites = this.pendingWrites.slice()
    this.pendingWrites.length = 0

    const linesToBeWritten = pendingWrites.length
    const buf = Buffer.from(
      pendingWrites.join('\n') + '\n'
    )

    /** Append the log to the end of the file */
    const { err: writeErr, data: bytesWritten } =
      await write(this.fd, buf, 0, buf.length, 0)

    // Use for verifying write syscalls in test.
    this._writeCalled++

    if (writeErr) {
      return {
        err: wrapf('_write() could not write(fd)', writeErr, {
          productName: this.productName,
          fd: this.fd,
          logFileLocation: this.logFileLocation
        })
      }
    }

    /**
     * If for some reason this is a partial write enqueue a new
     * line onto the write queue so that the next line is valid
     * JSON.
     *
     * A partial write is 99% garantueed to be invalid JSON and
     * the new line character at the end will be missing.
     */
    if (bytesWritten !== buf.length) {
      this.pendingWrites.push('\n')
    }

    const newLineByte = '\n'.charCodeAt(0)
    for (let i = 0; i < bytesWritten; i++) {
      if (buf[i] === newLineByte) {
        this.newLineOffsets.push(this.size + i)
      }
    }

    this.bytesWritten += bytesWritten
    this.size += bytesWritten

    // This is best effort and over estimates in case of partial write.
    this.lines += linesToBeWritten

    if (this.lines >= MAX_LOG_LINES) {
      /**
       * We want to truncate 25%; so find the offset of the
       * 25th percentile line
       */
      const lineIndex = Math.floor(MAX_LOG_LINES / 4)
      const offset = this.newLineOffsets[lineIndex]

      return this._truncate(offset + 1, lineIndex)
    }

    if (this.size >= MAX_LOG_FILE_SIZE) {
      /**
       * We want to truncate 25%; so find the nearest newline
       * to the 25th percentile byte size.
       */
      const minimumOffset = Math.floor(MAX_LOG_FILE_SIZE / 4)
      let offset = minimumOffset
      let lineIndex = -1
      for (let i = 0; i < this.newLineOffsets.length; i++) {
        if (this.newLineOffsets[i] > minimumOffset) {
          offset = this.newLineOffsets[i]
          lineIndex = i
          break
        }
      }

      return this._truncate(offset + 1, lineIndex)
    }

    return {}
  }

  /**
   * Truncating is a bitch. You cannot delete the start of a file.
   *
   * You cannot prepend to a file either. What we can do however
   * is to create a temporary file. We then read from a certain
   * offset on the main file and copy the last 75% into the
   * temporary file.
   *
   * Then we do an atomic rename of the file back to the original
   * file name.
   *
   * After we finish the "Copy + rename" we must swap the fd
   * descriptor of the old file for the new one.
   *
   * Oh and unlink the temporary file too !
   */
  async _truncate (position, lineIndex) {
    const writeStream = fs.createWriteStream(
      this.logFileLocation + '.tmp'
    )
    const readStream = fs.createReadStream(this.logFileLocation, {
      start: position
    })

    const { err: pipeErr } =
      await pipeline(readStream, writeStream)
    if (pipeErr) {
      return {
        err: wrapf('_truncate(): could not pipeline', pipeErr, {
          logFileLocation: this.logFileLocation,
          position: position,
          productName: this.productName,
          destination: this.logFileLocation + '.tmp'
        })
      }
    }

    const { err: renameErr } = await rename(
      this.logFileLocation + '.tmp', this.logFileLocation
    )
    if (renameErr) {
      return {
        err: wrapf('_truncate(): could not rename', renameErr, {
          logFileLocation: this.logFileLocation,
          productName: this.productName,
          tmpFile: this.logFileLocation + '.tmp'
        })
      }
    }

    if (lineIndex === -1) {
      this.lines = 0
      this.size = 0
      this.newLineOffsets.length = 0

      const { err: closeErr } = await close(this.fd)
      if (closeErr) {
        const oldFd = this.fd
        this.fd = null
        return {
          err: wrapf('_truncate(): could not close', closeErr, {
            logFileLocation: this.logFileLocation,
            productName: this.productName,
            fd: oldFd
          })
        }
      }

      return this.open()
    }

    this.lines = this.lines - lineIndex - 1
    this.size = this.size - position
    this.newLineOffsets = this.newLineOffsets.slice(lineIndex + 1)
    for (let i = 0; i < this.newLineOffsets.length; i++) {
      this.newLineOffsets[i] -= position
    }

    const oldFd = this.fd

    const { err: openErr, data: fd } =
      await open(this.logFileLocation, 'a+')
    if (openErr) {
      return {
        err: wrapf('_truncate(): could not re open', openErr, {
          logFileLocation: this.logFileLocation,
          productName: this.productName
        })
      }
    }
    this.fd = fd

    const { err: closeErr } = await close(oldFd)
    if (closeErr) {
      return {
        err: wrapf('_truncate(): could not close old fd', closeErr, {
          logFileLocation: this.logFileLocation,
          productName: this.productName,
          oldFd: oldFd
        })
      }
    }

    return {}
  }

  async destroy () {
    const { err: closeErr } = await close(this.fd)
    if (closeErr) {
      return {
        err: wrapf('destroy(): could not close', closeErr, {
          fd: this.fd,
          logFileLocation: this.logFileLocation,
          productName: this.productName
        })
      }
    }

    this.fd = null

    const { err: unlinkErr } = await unlink(this.logFileLocation)
    if (unlinkErr) {
      return {
        err: wrapf('destroy(): could not unlink', unlinkErr, {
          logFileLocation: this.logFileLocation,
          productName: this.productName
        })
      }
    }

    return {}
  }

  getWriteCalledCounter () {
    return this._writeCalled
  }
}

class MainLogger {
  constructor (productName, options) {
    assert(productName, 'productName required')
    assert(options.fileName, 'options.fileName required')
    assert(!options.shortName || options.shortName.length <= 7,
      'options.shortName must be 7 char or less')

    this.fsLogger = new AppendOnlyFSLogger(productName, options)

    this.console = options.console || false
    this.shortName = options.shortName
      ? options.shortName.padStart(7, ' ') : ''
    this.prefix = options.prefix || ''

    if (options.isMain) {
      const mainPrefix = this.shortName
        ? `${this.shortName}:main` : 'main'
      this.prefix = green(mainPrefix) + ' '
    }

    const renderPrefix = this.shortName
      ? `${this.shortName}:rend` : 'rend'
    this.renderPrefix = magenta(renderPrefix) + ' '
  }

  open () {
    return this.fsLogger.open()
  }

  destroy () {
    return this.fsLogger.destroy()
  }

  logIPC (level, msg, info, timestamp) {
    this._log(level, msg, info, timestamp, this.renderPrefix)
  }

  _log (level, msg, info, timestamp, prefix) {
    if (!this.fsLogger.hasOpened) {
      throw new Error('Must call open() first.')
    }

    if (!msg || typeof msg !== 'string') {
      throw new Error(level + '(msg); msg is mandatory')
    }
    if (info && typeof info !== 'object') {
      throw new Error(level + '(msg, info); info must be object')
    }

    if (info) {
      for (const k of Object.keys(info)) {
        if (isError(info[k])) {
          info[k] = errorToObject(info[k])
        }
      }
    }

    if (this.console) {
      this._logConsole(level, msg, info, timestamp, prefix)
    }

    return this.fsLogger._write(level, msg, info, timestamp)
  }

  _logConsole (level, msg, info, timestamp, prefix) {
    let timeStr = shortFormateTime(timestamp)

    timeStr = level === 'info'
      ? cyan(timeStr) : level === 'warn'
        ? yellow(timeStr) : level === 'error'
          ? red(timeStr) : timeStr

    let infoText = info ? util.inspect(info, {
      breakLength: 65,
      colors: true,
      depth: 4
    }) : '{}'

    if (infoText.length > 8 * 1024) {
      infoText = infoText.slice(0, 8 * 1024 - 3) + '...\u001b[39m'
    }

    const consoleLogText = `${timeStr} › ${msg}: ${infoText}`

    if (level === 'error') {
      console.error(prefix + consoleLogText)
    } else {
      console.log(prefix + consoleLogText)
    }
  }

  info (msg, info) {
    return this._log('info', msg, info, Date.now(), this.prefix)
  }

  warn (msg, info) {
    return this._log('warn', msg, info, Date.now(), this.prefix)
  }

  error (msg, info) {
    return this._log('error', msg, info, Date.now(), this.prefix)
  }
}

MainLogger.LogLine = LogLine
module.exports = MainLogger

function isError (err) {
  if (typeof err !== 'object') {
    return false
  }

  if (err instanceof Error) {
    return true
  }

  while (err) {
    if (Object.prototype.toString.call(err) === '[object Error]') {
      return true
    }

    err = Object.getPrototypeOf(err)
  }
  return false
}

function stackToString (e) {
  let stack = e.stack
  let causeError

  if (typeof e.cause === 'function') {
    causeError = e.cause()
    stack += '\nCaused by: ' + stackToString(causeError)
  }

  return stack
}

function errorToObject (err) {
  const ret = { ...err }
  ret.name = err.name
  ret.message = err.message
  ret.type = err.type
  ret.stack = stackToString(err)
  return ret
}

function warnOnError (err) {
  console.error('AppendOnlyFSLogger could not write logline', {
    err: err
  })
}

function shortFormateTime (timestamp) {
  const date = new Date(timestamp)
  const timeStr =
    pad(date.getHours()) + '.' +
    pad(date.getMinutes()) + '.' +
    pad(date.getSeconds()) + '.' +
    pad(date.getMilliseconds(), 3)

  return timeStr
}

function pad (number, zeros) {
  let str = String(number)
  while (str.length < zeros) {
    str = '0' + str
  }

  return str
}

function cyan (text) {
  return '\u001b[36m' + text + '\u001b[39m'
}

function red (text) {
  return '\u001b[31m' + text + '\u001b[39m'
}

function yellow (text) {
  return '\u001b[33m' + text + '\u001b[39m'
}

function green (text) {
  return '\u001b[32m' + text + '\u001b[39m'
}

function magenta (text) {
  return '\u001b[35m' + text + '\u001b[39m'
}
