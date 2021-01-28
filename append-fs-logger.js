// @ts-check
'use strict'

const fs = require('fs')
const path = require('path')
const assert = require('assert')
const stream = require('stream')
const os = require('os')

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

const hostname = os.hostname()

class LogLine {
  /**
   * @param {string} name
   * @param {string} level
   * @param {string} msg
   * @param {object} info
   * @param {number} time
   * @param {string} [truncated]
   */
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

class OpenFailError extends WError {
  /**
   * @param {string} message
   * @param {NodeJS.ErrnoException} cause
   * @param {object} info
   */
  constructor (message, cause, info) {
    super(message, cause, info)

    this.shouldBail = false
    this.code = cause.code
    this.syscall = cause.syscall
    this.path = cause.path
  }
}

class AppendOnlyFSLogger {
  /**
   * @param {string} productName
   * @param {{
   *    fileName: string,
   *    onError?: (err: Error) => void
   * }} options
   */
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
    /** @type {number[]} */
    this.newLineOffsets = []

    // The current pending flush task
    this.pendingFlush = null
    // Pending loglines to be written
    /** @type {string[]} */
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
        Reflect.set(err, 'shouldBail', true)
      }

      return { err: err }
    }

    this.hasOpened = true
    this.fd = fd
    return {}
  }

  /**
   * @param {string} level
   * @param {string} msg
   * @param {object} info
   * @param {number} time
   */
  _write (level, msg, info, time) {
    /**
     * TODO: @Raynos what is the performance impact of try/catch
     */
    try {
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
    } catch (unexpectedError) {
      const err = wrapf(
        '_write() threw an unexpected exception',
        unexpectedError,
        {
          productName: this.productName,
          logFileLocation: this.logFileLocation
        }
      )
      this.onError(err)
      return null
    }
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

    /** If the fd is poisoned here then return an error */
    if (!this.fd) {
      return {
        err: new Error('_flush() could not write, fd is null')
      }
    }

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
   *
   * @param {number} position
   * @param {number} lineIndex
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

AppendOnlyFSLogger.LogLine = LogLine
module.exports = AppendOnlyFSLogger

/**
 * @param {Error} err
 */
function warnOnError (err) {
  console.error('AppendOnlyFSLogger could not write logline', {
    err: err
  })
}
