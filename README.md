# Append FS logger

Lightweight, zero dependency `logger` designed mostly for
`electron` applications.

|        |  append-fs-logger  |  pino  |  log4js   |  bunyan  |  winston  |  logtron |
|--------|:------------------:|:------:|:---------:|:--------:|:---------:|:--------:|
|pkg size|    64 KB           | 480 KB |  562 KB   |  3.82 MB |   3.4 MB  |  5.55 MB |
|bundle size|  12 KB          | 97 KB  |  100 KB   |  17 KB   |   203 KB  |   170 KB |
|dep count|       0           |   8    |    13     |   21     |    42     |    105   |

## Example

```js
const path = require('path')
const MainLogger = require('append-fs-logger')

const fileName = path.join(__dirname, 'logs.nldj')
const logger = new MainLogger('my-app', {
  fileName: fileName,
  console: true
})

logger.info(msg, { extra: 'info' })
logger.warn(msg, { fullNested: { json: true } })
logger.error(msg, { fieldA: 'some info', err: err })
```

## Motivation

When doing logging in an electron app we want different defaults
then the logging behavior of a long running nodeJS server on
server hardware like EC2.

The electron app runs on a users computer and we cannot use
features like ElasticSearch or `logrotate`.

The features we want for a logger on a users computer is to
log to DISK in a bounded fashion. This logger will write at most
32Mb to disk and will truncate it's own logfile to keep it below
32Mb.

If a user of your electron app submits a bug you can ask them
to upload the logfile written to disk.

This logger always supports writing to browser console and stdout
in the main process for local development convenience but this
should be disabled in the packaged application.

## Documentation

Logger supports `log.info()` ; `log.warn()` & `log.error()`.

Each level method (info(), warn(), error(), etc.) takes a string and an object of more information.

The logging methods also return a promises that resolves when
the logline has been flushed to disk.

The string message argument to the level method should be a static string, not a dynamic string. This allows anyone analyzing the logs to quickly find the callsite in the code and anyone looking at the callsite in the code to quickly grep through the logs to find all prints.

The object information argument should be the dynamic information that you want to log at the callsite. Things like an id, an uri, extra information, etc are great things to add here. You should favor placing dynamic information in the information object, not in the message string.

See [bunyan level descriptions](https://github.com/trentm/node-bunyan#levels) for more / alternative suggestions around how to use levels.

### `logger.info(message, information)`

info() is meant to used when you want to print informational messages that concern application or business logic. These messages should just record that a "useful thing" has happened.

You should use warn() or error() if you want to print that a "strange thing" or "wrong thing" has happened

### `logger.warn(message, information)`

warn() is meant to be used when you want to print warning messages that concern application or business logic. These messages should just record that an "unusual thing" has happened.

If your in a code path where you cannot recover or continue cleanly you should consider using error() instead. warn() is generally used for code paths that are correct but not normal.

### `logger.error(message, information)`

error() is meant to be used when you want to print error messages that concern application or business logic. These messages should just record that a "wrong thing" has happened.

You should use error() whenever something incorrect or unhandlable happens.

If your in a code path that is uncommon but still correct consider using warn() instead.
