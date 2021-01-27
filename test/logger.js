// @ts-check
'use strict'

const path = require('path')
const os = require('os')
const fs = require('fs')

const { resultify } = require('../resultify.js')

/** @type {import('assert')} */
const nodeAssert = require('assert')
const CollapsedAssert = require('collapsed-assert')
const test = require('@pre-bundled/tape')
const uuid = require('uuid').v4

const AppendOnlyFSLogger = require('../index.js')
const LogLine = AppendOnlyFSLogger.LogLine

const readFile = resultify(fs.readFile)
const writeFile = resultify(fs.writeFile)
const open = resultify(fs.open)
const chmod = resultify(fs.chmod)
const close = resultify(fs.close)
const PRODUCT_NAME = 'electron-main'

const smallStr = new Array(1024).join('A')
const IS_ISO_STRING = /\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+/

process.on('unhandledRejection', (err) => {
  process.nextTick(() => { throw err })
})

/**
 * TODO: @Raynos ; how do we test EAGAIN on write or how do we
 *    test partial writes because if sig interrupts.
 */
test.skip('when does write() return EAGAIN err')
test.skip('when does write() not write all the bytes ?')

test('logging to a file', async (assert) => {
  const fileName = path.join(os.tmpdir(), `${uuid()}.json`)

  const logger = new AppendOnlyFSLogger(PRODUCT_NAME, {
    fileName: fileName
  })
  assert.ok(logger)

  const { err: err1 } = await logger.open()
  assert.ifError(err1)

  logger.info('hello', { some: 'fields' })
  await sleep(25)

  const { err: err2, data: str } =
    await readFile(fileName, 'utf8')
  assert.ifError(err2)
  const lines = str.split('\n')

  assert.equal(lines.length, 2)
  const jsonObj = JSON.parse(lines[0])

  const time = jsonObj.time
  delete jsonObj.time
  assert.ok(time)

  const delta = Date.now() - Date.parse(time)
  assert.ok(delta < 250 && delta >= 0)

  assert.deepEqual(jsonObj, {
    name: PRODUCT_NAME,
    hostname: os.hostname(),
    pid: process.pid,
    level: 'info',
    msg: 'hello',
    v: 1,
    fields: {
      some: 'fields'
    }
  })

  fs.unlinkSync(fileName)
  assert.end()
})

// logger at all tests
test('Throw loud error on READONLY file system', async (assert) => {
  const fileName = path.join(os.tmpdir(), `${uuid()}.json`)

  const { err: writeErr } = await writeFile(fileName, 'some text')
  assert.ifError(writeErr)

  const { err: chmodErr } =
    await chmod(fileName, 0o444)
  assert.ifError(chmodErr)

  const logger = new AppendOnlyFSLogger(PRODUCT_NAME, {
    fileName: fileName
  })

  const { err: loggerErr } = await logger.open()
  assert.ok(loggerErr)
  nodeAssert(loggerErr)
  assert.equal(Reflect.get(loggerErr, 'code'), 'EACCES')
  assert.equal(Reflect.get(loggerErr, 'syscall'), 'open')

  /**
   * The open() method returns a special error with a shouldBail
   * property.
   */
  assert.equal(Reflect.get(loggerErr, 'shouldBail'), true)

  fs.unlinkSync(fileName)
  assert.end()
})

// open() tests
test('open fails on write only file', async (assert) => {
  const fileName = path.join(os.tmpdir(), `${uuid()}.json`)

  const { err: openErr, data: fd } =
    await open(fileName, 'wx', 0o222)
  assert.ifError(openErr)

  const { err: closeErr } = await close(fd)
  assert.ifError(closeErr)

  const logger = new AppendOnlyFSLogger(PRODUCT_NAME, {
    fileName: fileName
  })

  const { err: loggerErr } = await logger.open()
  assert.ok(loggerErr)
  nodeAssert(loggerErr)

  assert.equal(Reflect.get(loggerErr, 'code'), 'EACCES')
  assert.equal(Reflect.get(loggerErr, 'syscall'), 'open')
  assert.equal(Reflect.get(loggerErr, 'shouldBail'), false)

  fs.unlinkSync(fileName)
  assert.end()
})

test('open on nested folder', async (assert) => {
  const fileName = path.join(os.tmpdir(), uuid(), `${uuid()}.json`)

  const logger = new AppendOnlyFSLogger(PRODUCT_NAME, {
    fileName: fileName
  })

  const { err } = await logger.open()
  assert.ifError(err)

  fs.unlinkSync(fileName)
  assert.end()
})

test('open two loggers on same fileName', async (assert) => {
  const logger = await makeLogger()

  const fileName = logger.fsLogger.logFileLocation
  const logger2 = new AppendOnlyFSLogger(PRODUCT_NAME, {
    fileName: fileName
  })

  const { err: openErr } = await logger2.open()
  assert.ifError(openErr)

  assert.end()
})

test('open the same logger twice', async (assert) => {
  const logger = await makeLogger()

  const { err: openErr } = await logger.open()
  assert.ok(openErr)
  nodeAssert(openErr)

  assert.equal(openErr.message, 'Cannot open twice()')

  assert.end()
})

test('open fails on read only file', async (assert) => {
  const fileName = path.join(os.tmpdir(), `${uuid()}.json`)

  const { err: writeErr } = await writeFile(fileName, 'some text')
  assert.ifError(writeErr)

  const { err: chmodErr } =
    await chmod(fileName, 0o444)
  assert.ifError(chmodErr)

  const logger = new AppendOnlyFSLogger(PRODUCT_NAME, {
    fileName: fileName
  })

  const { err: loggerErr } = await logger.open()
  assert.ok(loggerErr)
  nodeAssert(loggerErr)

  assert.equal(Reflect.get(loggerErr, 'code'), 'EACCES')
  assert.equal(Reflect.get(loggerErr, 'syscall'), 'open')
  assert.equal(Reflect.get(loggerErr, 'shouldBail'), true)

  fs.unlinkSync(fileName)
  assert.end()
})

test('open on existing file', async (assert) => {
  const fileName = path.join(os.tmpdir(), `${uuid()}.json`)

  const { err: writeErr } = await writeFile(
    fileName, '{"some text":"thats json"}\n{"more":"text"}\n'
  )
  assert.ifError(writeErr)

  const logger = new AppendOnlyFSLogger(PRODUCT_NAME, {
    fileName: fileName
  })

  const { err: loggerErr } = await logger.open()
  assert.ifError(loggerErr)

  const fsLogger = logger.fsLogger
  assert.equal(fsLogger.lines, 2)
  assert.equal(fsLogger.size, 43)

  await logger.info('message one', {})
  await logger.info('message two', {})

  const logs = await readLogs(logger)
  assert.equal(logs.length, 4)

  assert.equal(logs[0]['some text'], 'thats json')
  assert.equal(logs[1].more, 'text')
  assert.equal(logs[2].msg, 'message one')
  assert.equal(logs[3].msg, 'message two')

  fs.unlinkSync(fileName)
  assert.end()
})

// info / warn / error
test('info level', async (assert) => {
  const logger = await makeLogger()

  logger.info('hi', { some: 'fields' })

  const logs = await readLogs(logger)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'hi')
  assert.equal(logs[0].level, 'info')
  assert.equal(logs[0].fields.some, 'fields')

  logger.info('msg only', {})

  const logs2 = await readLogs(logger)
  assert.equal(logs2.length, 2)

  assert.equal(logs2[1].msg, 'msg only')
  assert.deepEqual(logs2[1].fields, {})

  unwrap(logger.destroy())
  assert.end()
})

test('warn level', async (assert) => {
  const logger = await makeLogger()

  logger.warn('hi', { some: 'fields' })

  const logs = await readLogs(logger)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'hi')
  assert.equal(logs[0].level, 'warn')
  assert.equal(logs[0].fields.some, 'fields')

  unwrap(logger.destroy())
  assert.end()
})

test('logging cyclic JSON', async (assert) => {
  /** @type {Error[]} */
  const errors = []
  const uncaughts = []
  const logger = await makeLogger({
    onError: (err) => { errors.push(err) }
  })

  /**
   * If the logger was buggy it would throw an unhandled
   * rejection which the test suite would forward to uncaught
   * exception.
   *
   * If we log inside the uncaught exception handler then
   * we would get a race condition
   */
  process.on('uncaughtException', uncaught)

  /** Create a uncaught exception */
  process.nextTick(() => {
    throw new Error('force uncaught')
  })

  const logs = await readLogs(logger)
  assert.equal(logs.length, 0)
  assert.equal(errors.length, 1)
  assert.equal(uncaughts.length, 1)

  const msg = errors[0].message
  assert.ok(msg.includes('_write() threw an unexpected exception:'))
  assert.ok(msg.includes('Converting circular structure to JSON'))

  process.removeListener('uncaughtException', uncaught)
  assert.end()

  /** @param {Error} err */
  function uncaught (err) {
    uncaughts.push(err)

    /**
     * Testing what happens when you log something bad
     * in the uncaught handler.
     *
     * If the uncaught handler causes logger.error() which
     * causes an uncaught exception in the logger then you
     * get an infinite logging loop.
     */
    const cyclic = {}
    cyclic.cyclic = cyclic

    process.nextTick(() => {
      logger.error('error', {
        msg: 'lol rekt son',
        err: err,
        cyclic: cyclic
      })
    })
  }
})

test('error level', async (assert) => {
  const logger = await makeLogger()

  logger.error('hi', { some: 'fields' })

  const logs = await readLogs(logger)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'hi')
  assert.equal(logs[0].level, 'error')
  assert.equal(logs[0].fields.some, 'fields')

  unwrap(logger.destroy())
  assert.end()
})

test('message is mandatory', async (assert) => {
  const logger = await makeLogger()

  assert.throws(() => {
    // @ts-expect-error
    logger.info()
  }, /info\(msg\); msg is mandatory/)
  assert.throws(() => {
    // @ts-expect-error
    logger.warn()
  }, /warn\(msg\); msg is mandatory/)
  assert.throws(() => {
    // @ts-expect-error
    logger.error()
  }, /error\(msg\); msg is mandatory/)

  unwrap(logger.destroy())
  assert.end()
})

test('info, if exists must be object', async (assert) => {
  const logger = await makeLogger()

  assert.throws(() => {
    // @ts-expect-error
    logger.info('foo', 'bar')
  }, /info\(msg, info\); info must be object/)
  assert.throws(() => {
    // @ts-expect-error
    logger.warn('foo', 'bar')
  }, /warn\(msg, info\); info must be object/)
  assert.throws(() => {
    // @ts-expect-error
    logger.error('foo', 'bar')
  }, /error\(msg, info\); info must be object/)

  unwrap(logger.destroy())
  assert.end()
})

test('error objects serialize correctly', async function t (assert) {
  const logger = await makeLogger()

  const err = new Error('hello error')

  logger.error('oops!', { err: err })

  const logs = await readLogs(logger)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'oops!')
  assert.equal(logs[0].level, 'error')
  assert.deepEqual(logs[0].fields.err, {
    name: 'Error',
    message: 'hello error',
    stack: err.stack
  })

  const logErr = logs[0].fields.err
  assert.ok(logErr.stack.includes('at Test.t '))
  assert.ok(logErr.stack.includes(__filename))

  unwrap(logger.destroy())
  assert.end()
})

test('error objects stack contains cause', async function t (assert) {
  const CustomError = class CustomError extends Error {
    /**
     * @param {Error} cause
     * @param {string} message
     */
    constructor (cause, message) {
      super(message)

      this.__cause = cause
    }

    cause () {
      return this.__cause
    }
  }

  const logger = await makeLogger()

  const baseErr = makeError()
  const customErr = makeCustomError(baseErr)

  logger.error('oops!', { err: customErr })

  const logs = await readLogs(logger)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'oops!')
  assert.equal(logs[0].level, 'error')
  assert.deepEqual(logs[0].fields.err, {
    __cause: {},
    name: 'Error',
    message: 'wrapped error',
    stack: customErr.stack + '\nCaused by: ' +
      baseErr.stack
  })

  const err = logs[0].fields.err
  assert.ok(err.stack.includes('at Test.t '))
  assert.ok(err.stack.includes(__filename))
  assert.ok(err.stack.includes('at makeCustomError '))
  assert.ok(err.stack.includes('at makeError '))
  assert.ok(err.stack.includes('this is a plain error'))

  unwrap(logger.destroy())
  assert.end()

  /** @param {Error} err */
  function makeCustomError (err) {
    return new CustomError(err, 'wrapped error')
  }

  function makeError () {
    return new Error('this is a plain error')
  }
})

// concurrent logs tests
test('concurrent writes are batched', async (assert) => {
  const logger = await makeLogger()

  for (let i = 0; i < 5; i++) {
    logger.info('a simple msg', {
      with: 'a field'
    })
  }

  const logs = await readLogs(logger)
  assert.equal(logs.length, 5)
  assert.equal(logger.fsLogger.getWriteCalledCounter(), 2)

  assert.end()
})

test('queuing up many large log writes at once', async (assert) => {
  const logger = await makeLogger()

  for (let i = 0; i < 1024; i++) {
    logger.info('a simple msg', {
      with: 'a field'
    })
    if (i % 100 === 0) await sleep(25)
  }

  const logs = await readLogs(logger)
  assert.equal(logs.length, 1024)
  assert.equal(
    logger.fsLogger.getWriteCalledCounter(), (11 * 2) + 1
  )

  assert.end()
})

// _write tests
test('must open before logging', async function t (assert) {
  const fileName = path.join(os.tmpdir(), `${uuid()}.json`)

  const logger = new AppendOnlyFSLogger(PRODUCT_NAME, {
    fileName: fileName
  })

  assert.throws(() => {
    // @ts-expect-error
    logger.info('foo')
  }, /Must call open\(\) first/)

  assert.end()
})

test('writing to fd===null', async function t (assert) {
  /** @type {Error[]} */
  const errors = []
  const logger = await makeLogger({
    onError: (err) => { errors.push(err) }
  })

  /** Poison the logger by setting fd to null */
  logger.fsLogger.fd = null

  /**
   * If the logger was buggy it would throw an unhandled
   * rejection which the test suite would forward to uncaught
   * exception.
   *
   * If we log inside the uncaught exception handler then
   * we would get a race condition
   */
  process.on('uncaughtException', uncaught)

  logger.info('hello', {})

  const logs = await readLogs(logger)
  assert.equal(logs.length, 0)
  assert.equal(errors.length, 1)

  assert.equal(
    errors[0].message,
    '_flush() could not write, fd is null'
  )

  process.removeListener('uncaughtException', uncaught)
  assert.end()

  /** @param {Error} err */
  function uncaught (err) {
    console.log('uncaught')
    errors.push(err)

    logger.error('error', {
      msg: 'lol rekt son',
      err: err
    })
  }
})

test('truncates logline > MAX_LOG_LINE_SIZE', async (assert) => {
  const logger = await makeLogger()
  const largeStr = new Array(128).join(smallStr)

  logger.info('a really large msg', {
    largeStr: largeStr
  })

  const lines = await readLogs(logger)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].msg, 'a really large msg')
  assert.equal(lines[0].fields.isTruncated, true)
  assert.ok(lines[0].truncated)
  assert.ok(lines[0].truncated.endsWith('...'))

  const trunc = lines[0].truncated.slice(0, 200)
    .replace(IS_ISO_STRING, '')

  assert.ok(trunc.startsWith(
    `{"name":"electron-main","hostname":"${os.hostname()}",` +
    `"pid":${process.pid},"level":"info","msg":"a really large msg",` +
    '"time":"Z","v":1,"fields":' +
    '{"largeStr":"AAAAAA'
  ))
  assert.equal(lines[0].truncated.length, 32 * 1024)

  unwrap(logger.destroy())
  assert.end()
})

test('write failure', async (assert) => {
  /** @type {Error | undefined} */
  let writeErr
  const logger = await makeLogger({
    onError: (err) => {
      writeErr = err
    }
  })

  logger.info('normal msg', {
    some: 'field'
  })

  // naughty close
  const { err: closeErr } = await close(logger.fsLogger.fd)
  assert.ifError(closeErr)

  await logger.info('another msg', {
    some: 'other field'
  })

  nodeAssert(writeErr)
  assert.ok(writeErr)

  assert.equal(
    writeErr.message,
    '_write() could not write(fd): EBADF: bad file descriptor, write'
  )

  const werr = /** @type {import('../error').WError} */ (writeErr)

  assert.equal(werr.toJSON().code, 'EBADF')
  assert.equal(werr.toJSON().syscall, 'write')

  assert.end()
})

test('tracking bytesWritten and size lines', async (assert) => {
  const logger = await makeLogger()

  await logger.info('normal msg', {
    some: 'field'
  })

  const fsLogger = logger.fsLogger
  const size = (JSON.stringify(
    new LogLine(fsLogger.productName, 'info', 'normal msg', {
      some: 'field'
    }, Date.now())
  ) + '\n').length

  assert.equal(fsLogger.lines, 1)
  assert.equal(fsLogger.size, size)
  assert.equal(fsLogger.bytesWritten, size)

  await logger.info('normal msg 22', {
    some: 'field2'
  })
  await logger.info('normal msg 125125 ', {
    some: 'field3'
  })
  await logger.info('normal msg 364634', {
    some: 'field4'
  })

  assert.equal(fsLogger.lines, 4)
  // log bytes written depends on pid, hostname, etc.
  assert.equal(fsLogger.size, size * 4 + 21)
  assert.equal(fsLogger.bytesWritten, size * 4 + 21)

  unwrap(logger.destroy())
  assert.end()
})

test('truncates file on MAX_LOG_LINES', async (assert) => {
  const logger = await makeLogger()

  for (let i = 0; i < 4095; i++) {
    logger.info('normal msg', {
      some: 'field',
      index: i
    })

    if (i % 100 === 0) await sleep(1)
  }

  const logs = await readLogs(logger)
  assert.equal(logs.length, 4095)

  const cassert = new CollapsedAssert()
  for (let i = 0; i < logs.length; i++) {
    cassert.equal(logs[i].fields.index, i)
  }
  cassert.report(assert, 'all indexes correct')

  let index = 4095
  await logger.info('normal msg', {
    some: 'field', index: index++
  })

  const logs2 = await readLogs(logger)
  assert.equal(logs2.length, 3071)
  assert.equal(logs2[logs2.length - 1].fields.index, index - 1)

  const cassert2 = new CollapsedAssert()
  for (let i = 0; i < logs2.length; i++) {
    cassert2.equal(logs2[i].fields.index, i + 1024 + 1)
  }
  cassert2.report(assert, 'all indexes correct')

  for (let i = 0; i < 10; i++) {
    await logger.info('normal msg', {
      some: 'field', index: index + i
    })
  }

  const logs3 = await readLogs(logger)
  assert.equal(logs3.length, 3081)
  assert.equal(logs3[logs3.length - 1].fields.index, index + 9)

  const cassert3 = new CollapsedAssert()
  for (let i = 0; i < logs3.length; i++) {
    cassert3.equal(logs3[i].fields.index, i + 1024 + 1)
  }
  cassert3.report(assert, 'all indexes correct')

  unwrap(logger.destroy())
  assert.end()
})

test('truncates many times', async (assert) => {
  const logger = await makeLogger()

  let totalLines = 0
  for (let i = 0; i < 20; i++) {
    const loopAmount = Math.floor(2000 + (Math.random() * 4000))

    let lastWrite
    for (let j = 0; j < loopAmount; j++) {
      lastWrite = logger.info('normal msg', {
        some: 'field',
        index: j
      })

      if (j % 100 === 0) {
        await lastWrite
        await sleep(1)
      }
    }
    totalLines += loopAmount

    await lastWrite
    const logs = await readLogs(logger)

    if (totalLines < 4096) {
      assert.equal(logs.length, totalLines)
    } else {
      let expectedLines = totalLines
      /**
       * Every time we log >4096 lines the logger will truncate
       * 25% which is 1025 due to rounding error.
       */
      while (expectedLines >= 4096) {
        expectedLines -= 1025
      }

      assert.equal(logs.length, expectedLines)
    }
  }

  unwrap(logger.destroy())
  assert.end()
})

test('truncates file on MAX_LOG_FILE_SIZE', async (assert) => {
  const logger = await makeLogger()

  const largeStr = new Array(16 + 1).join(smallStr)
  const expectedTruncate = 2 * 1024
  const OVERHEAD_OFFSET = 21

  let index = expectedTruncate - OVERHEAD_OFFSET
  let lastWrite
  for (let i = 0; i < index; i++) {
    lastWrite = logger.info('normal msg', {
      largeStr: largeStr,
      index: i
    })

    if (i % 100 === 0) await sleep(1)
  }

  await lastWrite

  const logs = await readLogs(logger)
  assert.equal(logs.length, 2027)

  const cassert = new CollapsedAssert()
  for (let i = 0; i < logs.length; i++) {
    cassert.equal(logs[i].fields.index, i)
  }
  cassert.report(assert, 'all indexes correct')

  for (let i = 0; i < OVERHEAD_OFFSET; i++) {
    await logger.info('normal msg', {
      largeStr: largeStr, index: index++
    })
  }

  const logs2 = await readLogs(logger)
  assert.ok(logs2.length >= 1540 && logs2.length <= 1541)
  assert.equal(logs2[logs2.length - 1].fields.index, index - 1)

  const cassert2 = new CollapsedAssert()
  for (let i = 0; i < logs2.length; i++) {
    const expectedIndex = i + 506 + 1

    cassert2.ok(
      logs2[i].fields.index >= expectedIndex - 1 &&
      logs2[i].fields.index <= expectedIndex + 1
    )
  }
  cassert2.report(assert, 'all indexes correct')

  for (let i = 0; i < 10; i++) {
    await logger.info('normal msg', {
      largeStr: largeStr, index: index + i
    })
  }

  const logs3 = await readLogs(logger)
  assert.ok(logs3.length >= 1550 && logs3.length <= 1551)
  assert.equal(logs3[logs3.length - 1].fields.index, index + 9)

  const cassert3 = new CollapsedAssert()
  for (let i = 0; i < logs3.length; i++) {
    const expectedIndex = i + 506 + 1

    cassert3.ok(
      logs3[i].fields.index >= expectedIndex - 1 &&
      logs3[i].fields.index <= expectedIndex + 1
    )
  }
  cassert3.report(assert, 'all indexes correct')

  unwrap(logger.destroy())
  assert.end()
})

test('truncated file truncates more if last line is long', async (assert) => {
  const logger = await makeLogger()
  const largeStr = new Array(128).join(smallStr)

  // Write 3000 small logs
  // Write 1000 large logs

  for (let i = 0; i < 3 * 1024; i++) {
    logger.info('normal msg', {
      some: 'field',
      normalStr: smallStr,
      index: i
    })

    if (i % 100 === 0) await sleep(1)
  }

  const logs = await readLogs(logger)
  assert.equal(logs.length, 3 * 1024)

  let lastWrite
  for (let i = 0; i < 1023; i++) {
    lastWrite = logger.info('large msg', {
      index: i + 3 * 1024,
      largeStr: largeStr
    })
  }

  await lastWrite

  const logs2 = await readLogs(logger)
  assert.ok(logs2.length >= 881 && logs2.length <= 882)

  const cassert = new CollapsedAssert()
  for (let i = 0; i < logs2.length; i++) {
    cassert.ok(logs2[i].fields.isTruncated)
    cassert.ok(logs2[i].truncated.includes(
      `"index":${3213 + i}`
    ) || logs2[i].truncated.includes((
      `"index":${3214 + i}`
    )))
  }
  cassert.report(assert, 'all indexes correct')

  unwrap(logger.destroy())
  assert.end()
})

/** @param {number} n */
function sleep (n) {
  return new Promise((resolve) => {
    setTimeout(resolve, n)
  })
}

/** @param {AppendOnlyFSLogger} logger */
async function readLogs (logger) {
  await sleep(25)
  const { err, data: buf } =
    await readFile(logger.fsLogger.logFileLocation)
  if (err) {
    throw err
  }

  /** @type {string} */
  const str = buf.toString('utf8')
  const lines = str.split('\n').filter(Boolean)

  const fsLogger = logger.fsLogger

  if (lines.length !== fsLogger.lines) {
    throw new Error('logger.lines invalid')
  }
  if (Buffer.byteLength(str) !== fsLogger.size) {
    throw new Error('logger.size invalid')
  }
  if (fsLogger.newLineOffsets.length !== fsLogger.lines) {
    throw new Error('logger.newLineOffsets invalid')
  }

  const newLineByte = '\n'.charCodeAt(0)
  for (const offset of fsLogger.newLineOffsets) {
    if (buf[offset] !== newLineByte) {
      throw new Error('logger.newLineOffsets invalid')
    }
  }

  return lines.map((s) => {
    return JSON.parse(s.trim())
  })
}

/**
 * @param {{
 *    onError?: (err: Error) => void
 * }} [options]
 */
async function makeLogger (options) {
  const fileName = path.join(os.tmpdir(), `${uuid()}.json`)

  const logger = new AppendOnlyFSLogger(PRODUCT_NAME, {
    fileName: fileName,
    onError: options ? options.onError : undefined
  })

  const { err } = await logger.open()
  if (err) throw err

  return logger
}

/**
 * @param {Promise<{ err?: Error }>} p
 */
async function unwrap (p) {
  const { err } = await p
  if (err) throw err
}
