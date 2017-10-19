/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

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
var DEFAULT_SESSION_TIMEOUT = 30000;



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

    /*
     * MANTA-3536 - if registrar is passed a config that specifies the ip
     * address of zookeeper server(s) with the 'host' field, copy the value into
     * a new 'address' field, which is what node-zkstream expects.
     */
    var servers = cfg.zookeeper.servers;
    var usesOldConfig = false;

    if (servers) {
        servers.forEach(function (server) {
            if (!server.address) {
                usesOldConfig = true;
                server.address = server.host;
            }
        });
    } else {
        if (!cfg.zookeeper.address) {
            usesOldConfig = true;
            cfg.zookeeper.address = cfg.zookeeper.host;
        }
    }

    /*
     * MANTA-3536 - node-zkstream uses the option 'sessionTimeout' instead of
     * 'timeout'. Older configs aimed at node-zkplus will specify the timeout
     * using 'timeout' field, so we translate it here for backwards
     * compatibility.
     */
    if (!cfg.zookeeper.sessionTimeout) {
        usesOldConfig = true;
        cfg.zookeeper.sessionTimeout = cfg.zookeeper.timeout ||
            DEFAULT_SESSION_TIMEOUT;
    }

    if (usesOldConfig) {
        LOG.warn('registrar configuration uses old zookeeper options, ' +
                'converting to new format and continuing');
    }

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

    app.createZKClient(cfg.zookeeper, function (zk) {
        assert.object(zk, 'zk');

        // backward compatible with top-level 'adminIp' in configs.
        cfg.registration.adminIp = cfg.registration.adminIp || cfg.adminIp;

        var opts = clone(cfg.registration);
        if (cfg.healthCheck) {
            opts.healthCheck = clone(cfg.healthCheck);
            opts.healthCheck.log = LOG;
            opts.healthCheck.zk = zk;
        }
        opts.log = LOG;
        opts.registration = cfg.registration;
        opts.sessionTimeout = cfg.zookeeper.sessionTimeout;
        opts.zk = zk;

        var registrar = app.createRegistrar(opts);

        /*
         * If registrar.zk is null, this meant that there has already been an
         * event that triggered the termination of the session, and we can
         * safely exit. Otherwise, the work has to be done here.
         */
        function unregisterAndExit(signal) {
            if (registrar.zk === null) {
                LOG.debug('registrar: received ' + signal + ', but the zk ' +
                        'session is already terminated.');
                process.exit(0);
            }
            LOG.info('registrar: received ' + signal + ', unregistering ' +
                    'ephemeral nodes.');
            var unregisterOpts = {
                log: LOG,
                zk: zk
            };
            app.unregister(unregisterOpts, registrar, function (err) {
                if (err) {
                    LOG.debug(err, 'registrar: unexpected error ' +
                        'unregistering nodes');
                }
                process.exit(0);
            });
        }

        var exitSignals = [
            'SIGTERM',
            'SIGINT'
        ];

        exitSignals.forEach(function (signal) {
            process.on(signal, function () {
                unregisterAndExit(signal);
            });
        });

        // node-zkstream events
        zk.on('connect', function () {
            LOG.info('zookeeper: connected');
        });

        zk.on('close', function () {
            LOG.warn('zookeeper: disconnected');
        });


        zk.on('session', function () {
            LOG.info('zookeeper: session established');

            registrar.registerOnNewSession(function (rerr) {
                if (rerr) {
                    LOG.error(rerr, 'registration(%j) failed this session. ',
                        opts.registration);
                    return;
                }
                LOG.debug('registration successful for session generation ' +
                    registrar.getSessionGeneration());

                if (registrar.hasHealthCheck()) {
                    return;
                }

                var healthCheckEvents = registrar.createHealthCheck();

                // health-check events
                healthCheckEvents.on('fail', function (err) {
                    LOG.error(err, 'registrar: healthcheck failed');
                });

                healthCheckEvents.on('ok', function () {
                    LOG.info('registrar: healthcheck ok (was down)');
                });

                healthCheckEvents.on('error', function (err) {
                    LOG.error(err, 'registrar: unexpected error');
                });

                healthCheckEvents.on('register', function (nodes) {
                    LOG.info({
                        znodes: nodes
                    }, 'registrar: registered');
                });

                healthCheckEvents.on('unregister', function (err, nodes) {
                    LOG.warn({
                        err: err,
                        znodes: nodes
                    }, 'registrar: unregistered');
                });

            });
        });

        zk.on('expire', function () {
            LOG.warn('zookeeper: session expired');
        });

        zk.on('failed', function () {
            LOG.warn('zookeeper: failed');
        });
    });
})();
