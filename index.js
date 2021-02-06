// @ts-check
'use strict'

const util = require('util')
const assert = require('assert')

const RotatingFileLogger = require('./rotating-file-logger.js')

class MainLogger {
  /**
   * @param {string} productName
   * @param {{
   *    fileName: string,
   *    shortName?: string,
   *    console?: boolean,
   *    prefix?: string,
   *    isMain?: boolean,
   *    onError?: (err: Error) => void
   * }} options
   */
  constructor (productName, options) {
    assert(productName, 'productName required')
    assert(options.fileName, 'options.fileName required')
    assert(!options.shortName || options.shortName.length <= 7,
      'options.shortName must be 7 char or less')

    this.fsLogger = new RotatingFileLogger(productName, options)

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

  /** @returns {Promise<{ err?: Error }>} */
  open () {
    return this.fsLogger.open()
  }

  /** @returns {Promise<{ err?: Error }>} */
  destroy () {
    return this.fsLogger.destroy()
  }

  /**
   * Utility method for writing logs from renderer process
   * to the main logger.
   *
   * @param {string} level
   * @param {string} msg
   * @param {Record<string, unknown>} info
   * @param {number} timestamp
   */
  logIPC (level, msg, info, timestamp) {
    this._log(level, msg, info, timestamp, this.renderPrefix)
  }

  /**
   * @param {string} level
   * @param {string} msg
   * @param {Record<string, unknown>} info
   * @param {number} timestamp
   * @param {string} prefix
   */
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
          info[k] = errorToObject(
            /** @type {Error} */ (info[k])
          )
        }
      }
    }

    if (this.console) {
      this._logConsole(level, msg, info, timestamp, prefix)
    }

    return this.fsLogger.writeLog(level, msg, info, timestamp)
  }

  /**
   * @param {string} level
   * @param {string} msg
   * @param {object} info
   * @param {number} timestamp
   * @param {string} prefix
   */
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

  /**
   * @param {string} msg
   * @param {Record<string, unknown>} info
   */
  info (msg, info) {
    return this._log('info', msg, info, Date.now(), this.prefix)
  }

  /**
   * @param {string} msg
   * @param {Record<string, unknown>} info
   */
  warn (msg, info) {
    return this._log('warn', msg, info, Date.now(), this.prefix)
  }

  /**
   * @param {string} msg
   * @param {Record<string, unknown>} info
   */
  error (msg, info) {
    return this._log('error', msg, info, Date.now(), this.prefix)
  }
}

module.exports = MainLogger

/**
 * @param {unknown} err
 */
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

/**
 * @param {Error} e
 */
function stackToString (e) {
  let stack = e.stack
  let causeError

  if (typeof Reflect.get(e, 'cause') === 'function') {
    const werr = /** @type {import('./error').WError} */ (e)
    causeError = werr.cause()
    stack += '\nCaused by: ' + stackToString(causeError)
  }

  return stack
}

/**
 * @param {Error} err
 */
function errorToObject (err) {
  /** @type {Error & { type?: string }} */
  const ret = { ...err }
  ret.name = err.name
  ret.message = err.message
  ret.type = Reflect.get(err, 'type')
  ret.stack = stackToString(err)
  return ret
}

/**
 * @param {number} timestamp
 */
function shortFormateTime (timestamp) {
  const date = new Date(timestamp)
  const timeStr =
    pad(date.getHours()) + '.' +
    pad(date.getMinutes()) + '.' +
    pad(date.getSeconds()) + '.' +
    pad(date.getMilliseconds(), 3)

  return timeStr
}

/**
 * @param {number | string} number
 * @param {number} [zeros]
 */
function pad (number, zeros) {
  zeros = zeros || 0

  let str = String(number)
  while (str.length < zeros) {
    str = '0' + str
  }

  return str
}

/** @param {string} text */
function cyan (text) {
  return '\u001b[36m' + text + '\u001b[39m'
}

/** @param {string} text */
function red (text) {
  return '\u001b[31m' + text + '\u001b[39m'
}

/** @param {string} text */
function yellow (text) {
  return '\u001b[33m' + text + '\u001b[39m'
}

/** @param {string} text */
function green (text) {
  return '\u001b[32m' + text + '\u001b[39m'
}

/** @param {string} text */
function magenta (text) {
  return '\u001b[35m' + text + '\u001b[39m'
}
