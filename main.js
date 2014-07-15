// Copyright (c) 2014, Joyent, Inc. All rights reserved.

var fs = require('fs');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var clone = require('clone');
var dashdash = require('dashdash');

var app = require('./lib');


///--- Globals

var LOG = bunyan.createLogger({
    level: (process.env.LOG_LEVEL || 'info'),
    name: 'registrar',
    serializers: bunyan.stdSerializers,
    stream: process.stdout
});
var OPTIONS = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    },
    {
        names: ['verbose', 'v'],
        type: 'arrayOfBool',
        help: 'Verbose output. Use multiple times for more verbose.'
    },
    {
        names: ['file', 'f'],
        type: 'string',
        help: 'File to process',
        helpArg: 'FILE'
    }
];



///--- CLI Helpers

function configure(argv) {
    assert.object(argv, 'options');
    assert.string(argv.file, 'options.file');

    var cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(argv.file, 'utf8'));
    } catch (e) {
        LOG.fatal(e, 'unable to read configuration %s', argv.file);
        process.exit(1);
    }

    LOG.info(cfg, 'configuration loaded from %s', argv.file);

    if (cfg.logLevel)
        LOG.level(cfg.logLevel);

    if (argv.verbose) {
        argv.verbose.forEach(function () {
            LOG.level(Math.max(bunyan.TRACE, (LOG.level() - 10)));
        });
    }

    if (LOG.level() <= bunyan.DEBUG)
        LOG = LOG.child({src: true});

    assert.object(cfg.zookeeper, 'config.zookeeper');
    assert.optionalObject(cfg.healthCheck, 'config.healthCheck');

    cfg.zookeeper.log = LOG;

    return (cfg);
}


function usage(help, msg) {
    if (msg)
        console.error(msg);

    console.log('usage: registrar [OPTIONS]\n'
                + 'options:\n'
                + help);

    process.exit(msg ? 1 : 0);
}



///--- Mainline

(function main() {
    var argv;
    var help;
    var parser;

    try {
        parser = dashdash.createParser({options: OPTIONS});
        argv = parser.parse(process.argv);
        help = parser.help({includeEnv: true}).trimRight();
    } catch (e) {
        console.error('foo: error: %s', e.message);
        process.exit(1);
    }

    if (argv.help)
        usage(help);

    if (!argv.file)
        usage(help, 'file is required');

    var cfg = configure(argv);

    app.createZKClient(cfg.zookeeper, function (init_err, zk) {
        if (init_err) {
            LOG.fatal(init_err, 'unable to create ZooKeeper client');
            process.exit(1);
        }

        zk.on('close', function () {
            LOG.warn('zookeeper: disconnected');
        });

        // annoyingly this fires twice, so ignore the first one
        zk.once('connect', function () {
            zk.on('connect', function () {
                LOG.info('zookeeper: reconnected');
            });
        });


        var is_down = false;
        var opts = clone(cfg.registration);
        if (cfg.healthCheck) {
            opts.healthCheck = clone(cfg.healthCheck);
            opts.healthCheck.log = LOG;
            opts.healthCheck.zk = zk;
        }
        opts.log = LOG;
        opts.registration = cfg.registration;
        opts.zk = zk;

        var eventStream = app(opts);

        eventStream.on('fail', function (err) {
            LOG.error(err, 'registrar: healthcheck failed');
        });

        eventStream.on('ok', function () {
            LOG.info('registrar: healthcheck ok (was down)');
        });

        eventStream.on('error', function (err) {
            LOG.error(err, 'registrar: unexpected error');
        });

        eventStream.on('register', function (nodes) {
            LOG.info({
                znodes: nodes
            }, 'registrar: registered');
        });

        eventStream.on('unregister', function (err, nodes) {
            LOG.warn({
                err: err,
                znodes: nodes
            }, 'registrar: unregistered');
        });

        eventStream.on('heartbeatFailure', function (err) {
            if (!is_down)
                LOG.error(err, 'zookeeper: heartbeat failed');
            is_down = true;
        });

        eventStream.on('heartbeat', function () {
            if (is_down)
                LOG.info('zookeeper heartbeat ok');

            is_down = false;
        });
    });
})();
