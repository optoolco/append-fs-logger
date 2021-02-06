// @ts-check
'use strict'

const assert = require('assert')
const path = require('path')
const os = require('os')

const rfs = require('raynos-rotating-file-stream')

const jsonStringifySafe = require('./json-stringify-safe.js')

const HOST_NAME = os.hostname()
const PID = process.pid
const EMPTY_OBJECT = {}

const MAX_LOG_LINE_SIZE = 32 * 1024
const MAX_LOG_FILE_SIZE = '32M'
const MAX_LOG_FILES = 5

class RotatingFileLogger {
  /**
   * @param {string} productName
   * @param {{
   *    fileName: string,
   *    onError?: (err: Error) => void
   * }} options
   */
  constructor (productName, options) {
    assert(options.fileName, 'options.fileName required')
    assert(
      path.isAbsolute(options.fileName),
      'options.fileName must be an absolute path'
    )

    this.hasOpened = false

    this._logFileDirectory = path.dirname(options.fileName)
    this._logFileName = path.basename(options.fileName)
    this._productName = productName
    this._onError = options.onError || warnOnError

    /** @type {rfs.RotatingFileStream | null} */
    this._stream = null
  }

  // no-op ?
  /** @returns {Promise<{ err?: Error }>} */
  open () {
    return new Promise((resolve) => {
      const self = this

      if (self.hasOpened) {
        resolve({ err: new Error('Cannot open twice()') })
        return
      }

      const stream = self._stream = rfs.createStream(
        self._logFileName,
        {
          size: MAX_LOG_FILE_SIZE,
          maxFiles: MAX_LOG_FILES,
          compress: 'gzip',
          path: self._logFileDirectory
        }
      )

      stream.once('open', onOpen)
      stream.once('error', onError)

      function onOpen () {
        stream.removeListener('error', onError)

        self.hasOpened = true
        resolve({})
      }

      /** @param {Error} err */
      function onError (err) {
        stream.removeListener('open', onOpen)

        Reflect.set(err, 'shouldBail', true)
        resolve({ err: err })
      }
    })
  }

  // close stream
  /** @returns {Promise<{ err?: Error }>} */
  async destroy () {
    if (this._stream) {
      this._stream.destroy()
    }
    // TODO: either unlink file or add `unlink()` method.
    return {}
  }

  /**
   * @param {string} level
   * @param {string} msg
   * @param {object} info
   * @param {number} time
   */
  writeLog (level, msg, info, time) {
    assert(this._stream, 'cannot writeLogs without open.')

    const logLine = makeLogLineObject(
      this._productName, level, msg, info, time
    )

    let str = jsonStringifySafe(logLine)
    if (str.length > MAX_LOG_LINE_SIZE) {
      const truncLevel = level === 'info' ? 'warn' : level
      str = jsonStringifySafe(makeLogLineObject(
        this._productName,
        truncLevel,
        msg,
        { isTruncated: true },
        time,
        str.slice(0, MAX_LOG_LINE_SIZE - 3) + '...'
      ))
    }

    this._stream.write(str + '\n')
  }
}

module.exports = RotatingFileLogger

/**
 * @param {string} productName
 * @param {string} level
 * @param {string} msg
 * @param {object} info
 * @param {number} time
 * @param {string} [truncated]
 */
function makeLogLineObject (productName, level, msg, info, time, truncated) {
  return {
    name: productName,
    hostname: HOST_NAME,
    pid: PID,
    level: level,
    msg: msg,
    time: new Date(time).toISOString(),
    v: 1,
    fields: info || EMPTY_OBJECT,
    truncated: truncated
  }
}

/**
 * @param {Error} err
 */
function warnOnError (err) {
  console.error('AppendOnlyFSLogger could not write logline', {
    err: err
  })
}
