'use strict'

const SEEN_VALUE = {}

class RendererLogger {
  constructor (ipcRenderer, options = {}) {
    if (!ipcRenderer) throw new Error('ipcRenderer required')
    this.ipcRenderer = ipcRenderer

    this.console = 'console' in options ? options.console : true
  }

  _write (level, msg, info, timestamp) {
    return this.ipcRenderer.invoke('logger', {
      level: level,
      message: msg,
      info: info,
      timestamp: timestamp
    })
  }

  _log (level, msg, info, timestamp) {
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
      this._logConsole(level, msg, info, timestamp)
    }

    return this._write(level, msg, info, timestamp)
  }

  _logConsole (level, msg, info, timestamp) {
    info = info || {}
    const timeStr = shortFormateTime(timestamp)

    const format = `%c${timeStr}%c › `
    const colorStyle = level === 'info'
      ? 'color:green' : level === 'warn'
        ? 'color:orange' : level === 'error'
          ? 'color:darkred' : 'color:unset'

    if (level === 'error') {
      console.error(format, colorStyle, 'color:unset', msg, info)
    } else if (level === 'warn') {
      console.warn(format, colorStyle, 'color:unset', msg, info)
    } else {
      console.log(format, colorStyle, 'color:unset', msg, info)
    }
  }

  hookupUncaught () {
    const self = this
    process.on('uncaughtException', handleUncaught)
    process.on('unhandledRejection', handleUnhandledRejection)

    window.addEventListener('error', handleWindowError)
    window.addEventListener('unhandledrejection', handleWindowUnhandled)

    function handleWindowError (event) {
      event.preventDefault()
      handleUncaught(event.error || event)
    }

    function handleWindowUnhandled (event) {
      event.preventDefault()
      handleUnhandledRejection(event.reason)
    }

    function handleUnhandledRejection (err) {
      process.nextTick(rethrowUnhandledRejection)

      function rethrowUnhandledRejection () {
        handleUncaught(err)
      }
    }

    function handleUncaught (err) {
      /**
       * Sometimes window.onError and uncaughtException both
       * fire so we set a unique value to avoid double logging
       * the EXACT same uncaught exception.
       */
      if (err.__seen__ === SEEN_VALUE) {
        return
      }
      err.__seen__ = SEEN_VALUE

      try {
        /**
         * This happens with a cross domain <script> tag where an
         * uncaught exception occurred in some other <script> that
         * does not belong to the current domain....
         */
        if (err === null) {
          self.error('Uncaught exception in cross-domain <script>')
          return
        }

        self.error('uncaught exception happened', {
          err: err,
          stack: err.stack || new Error('temp').stack
        })
      } catch (_err) {
        /**
         * If an uncaught exception happens in the uncaught
         * exception then we cannot do much about it at all.
         */
        console.error('Uncaught in the handleUncaught()')
      }

      return true
    }
  }

  info (msg, info) {
    return this._log('info', msg, info, Date.now())
  }

  warn (msg, info) {
    return this._log('warn', msg, info, Date.now())
  }

  error (msg, info) {
    return this._log('error', msg, info, Date.now())
  }
}

module.exports = RendererLogger

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
