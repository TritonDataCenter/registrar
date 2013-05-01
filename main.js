// Copyright (c) 2013, Joyent, Inc. All rights reserved.

var fs = require('fs');
var os = require('os');

var assert = require('assert-plus');
var backoff = require('backoff');
var bunyan = require('bunyan');
var clone = require('clone');
var dashdash = require('dashdash');
var vasync = require('vasync');
var zkplus = require('zkplus');



///--- Globals

var HOSTNAME = os.hostname();
var LOG = bunyan.createLogger({
    level: (process.env.LOG_LEVEL || 'info'),
    name: 'registrar',
    serializers: {
        err: bunyan.stdSerializers.err
    },
    stream: process.stdout
});
var NODES = [];
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

function readConfig(opts) {
    assert.object(opts, 'options');
    assert.string(opts.file, 'options.file');

    var cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
    } catch (e) {
        LOG.fatal(e, 'unable to read configuration %s', opts.file);
        process.exit(1);
    }

    LOG.info(cfg, 'configuration loaded from %s', opts.file);

    if (cfg.logLevel)
        LOG.level(cfg.logLevel);

    if (opts.verbose) {
        opts.verbose.forEach(function () {
            LOG.level(Math.max(bunyan.TRACE, (LOG.level() - 10)));
        });
    }

    if (LOG.level() <= bunyan.DEBUG)
        LOG = LOG.child({src: true});



    cfg.zookeeper.log = LOG;
    return (cfg);
}


function usage(msg) {
    if (msg)
        console.error(msg);

    var str = 'usage: ' + require('path').basename(process.argv[1]);
    str += '[-h] [-v] [-f file]';
    console.error(str);
    process.exit(1);
}



///--- worker functions

function address(cfg) {
    if ((cfg || {}).adminIp)
        return (cfg.adminIp);

    var ifaces = os.networkInterfaces();
    var addrs = Object.keys(ifaces).filter(function (k) {
        return (!ifaces[k][0].internal);
    }).map(function (k) {
        return (ifaces[k][0]);
    });

    return (addrs[0].address);
}


function createZkClient(opts, cb) {
    assert.object(opts, 'options');
    assert.arrayOfObject(opts.servers, 'options.servers');
    assert.number(opts.timeout, 'options.timeout');
    assert.func(cb, 'callback');

    assert.ok((opts.servers.length > 0), 'options.servers empty');
    for (var i = 0; i < opts.servers.length; i++) {
        assert.string(opts.servers[i].host, 'servers.host');
        assert.number(opts.servers[i].port, 'servers.port');
    }

    function _createClient(_, _cb) {
        var client = zkplus.createClient(opts);

        function onConnect() {
            client.removeListener('error', onError);
            LOG.info('zookeeper: connected');
            _cb(null, client);
        }

        function onError(err) {
            client.removeListener('connect', onConnect);
            _cb(err);
        }


        client.once('connect', onConnect);
        client.once('error', onError);

        client.connect();
    }

    var retry = backoff.call(_createClient, null, cb);
    retry.failAfter(Infinity);
    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: 1000,
        maxDelay: 30000
    }));

    retry.on('backoff', function (number, delay) {
        var level;
        if (number === 0) {
            level = 'info';
        } else if (number < 5) {
            level = 'warn';
        } else {
            level = 'error';
        }
        LOG[level]({
            attempt: number,
            delay: delay
        }, 'zookeeper: connection attempted (failed)');
    });

    retry.start();

    return (retry);
}


function domainToPath(domain) {
    assert.string(domain, 'domain');

    // 1.moray.us-east.joyent.com) => /com/joyent/us-east/moray/1
    return ('/' + domain.split('.').reverse().join('/'));
}


function heartbeat(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.config, 'options.config');
    assert.arrayOfString(opts.nodes, 'options.nodes');
    assert.object(opts.zk, 'options.zk');
    assert.func(cb, 'callback');

    function check(_, _cb) {
        vasync.forEachParallel({
            func: opts.zk.stat.bind(opts.zk),
            inputs: opts.nodes
        }, _cb);
    }

    var retry = backoff.call(check, null, cb);
    retry.failAfter(opts.config.maxAttempts || 5);
    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: opts.config.initialDelay || 1000,
        maxDelay: opts.config.maxDelay || 30000
    }));
    retry.start();
}


function removeOldEntryFunc(path) {
    assert.string(path, 'path');

    return (function (opts, cb) {
        assert.object(opts, 'options');
        assert.string(opts.domain, 'opts.domain');
        assert.object(opts.log, 'options.log');
        assert.object(opts.zk, 'options.zk');
        assert.func(cb, 'callback');

        var log = opts.log;
        var zk = opts.zk;

        log.debug({
            domain: opts.domain,
            path: path
        }, 'removeOldEntry: entered');

        zk.unlink(path, function (err) {
            if (err && err.code !== zkplus.ZNONODE) {
                log.error({
                    domain: opts.domain,
                    err: err,
                    path: path
                }, 'removeOldEntry: zk.unlink failed');
                cb(err);
            } else {
                log.debug({
                    domain: opts.domain,
                    path: path
                }, 'removeOldEntry: done');
                cb();
            }
        });
    });
}


function removeOldEntries(opts, cb) {
    assert.object(opts, 'options');
    assert.string(opts.domain, 'opts.domain');
    assert.object(opts.log, 'options.log');
    assert.arrayOfString(opts.aliases, 'options.aliases');
    assert.object(opts.zk, 'options.zk');
    assert.func(cb, 'callback');

    var funcs = [];
    for (var i = 0; i < opts.aliases.length; ++i) {
        funcs.push(removeOldEntryFunc(opts.aliases[i]));
    }

    vasync.pipeline({
        'funcs': funcs,
        'arg': opts
    }, function (err, results) {
        if (err) {
            LOG.error(err, 'unable to remove old entries');
            cb(err);
        } else {
            LOG.info('removed old entries');
            cb();
        }

    });
}


function registerEntryFunc(path) {
    assert.string(path, 'path');

    return (function _registerEntry(opts, cb) {
        assert.object(opts, 'options');
        assert.object(opts.config, 'opts.config');
        assert.object(opts.registration, 'options.registration');
        assert.string(opts.registration.domain, 'options.registration.domain');
        assert.string(opts.domain, 'options.domain');
        assert.object(opts.log, 'options.log');
        assert.object(opts.zk, 'options.zk');
        assert.func(cb, 'callback');

        var domain = opts.domain;
        var log = opts.log;
        var registration = opts.registration;
        var zk = opts.zk;

        log.debug({
            domain: domain,
            path: path
        }, 'registerEntry: entered');

        zk.mkdirp(opts.path, function (err) {
            if (err) {
                log.error({
                    domain: domain,
                    path: opts.path,
                    err: err
                }, 'registerEntry: zk.mkdirp failed');
                cb(err);
                return;
            }

            log.debug({
                domain: domain,
                path: opts.path
            }, 'registerEntry: zk.mkdirp done');

            var options = {
                flags: ['ephemeral'],
                object: {
                    type: registration.type
                }
            };
            options.object[registration.type] = {
                address: address(opts.config)
            };
            if (typeof (registration.ttl) === 'number')
                options.object.ttl = registration.ttl;

            zk.creat(path, options, function (err2) {
                if (err2 && err2.code !== zkplus.ZNODEEXISTS) {
                    log.error({
                        domain: domain,
                        hostname: HOSTNAME,
                        path: path,
                        err: err
                    }, 'registerEntry: zk.creat failed');
                    cb(err2);
                    return;
                }

                log.info({
                    domain: domain,
                    hostname: HOSTNAME,
                    path: path,
                    data: options
                }, 'registerEntry: done');
                NODES.push(path);
                cb();
            });
        });
    });
}


function registerEntries(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.config, 'options.config');
    assert.object(opts.registration, 'options.registration');
    assert.string(opts.registration.domain, 'options.registration.domain');
    assert.string(opts.domain, 'options.domain');
    assert.object(opts.log, 'options.log');
    assert.object(opts.zk, 'options.zk');
    assert.arrayOfString(opts.aliases, 'options.aliases');
    assert.func(cb, 'callback');

    var funcs = [];
    for (var i = 0; i < opts.aliases.length; ++i) {
        funcs.push(registerEntryFunc(opts.aliases[i]));
    }

    vasync.pipeline({
        'funcs': funcs,
        'arg': opts
    }, function (err, results) {
        if (err) {
            LOG.error(err, 'unable to register entries');
            cb(err);
        } else {
            LOG.info('added entries');
            cb();
        }

    });
}


function registerService(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.registration, 'options.registration');
    assert.string(opts.registration.domain, 'options.registration.domain');
    assert.string(opts.domain, 'options.domain');
    assert.object(opts.log, 'options.log');
    assert.string(opts.path, 'options.path');
    assert.object(opts.zk, 'options.zk');
    assert.func(cb, 'callback');

    if (!opts.registration.service) {
        cb();
        return;
    }

    var registration = opts.registration;
    var domain = opts.registration.domain;
    var log = opts.log;
    var path = opts.path;
    var zk = opts.zk;

    log.debug({
        domain: domain,
        path: path
    }, 'registerService: entered');

    var obj = {
        type: 'service',
        service: registration.service
    };
    zk.update(path, obj, function (err) {
        if (err) {
            log.error({
                domain: domain,
                path: path,
                err: err
            }, 'registerService: zk.update failed');
            cb(err);
        } else {
            log.debug({
                domain: domain,
                path: path
            }, 'registerService: zk.update done');

            if (NODES.indexOf(path) === -1)
                NODES.push(path);

            cb();
        }
    });
}


function register(opts, cb) {
    assert.object(opts, 'options');
    assert.string(opts.domain, 'options.domain');
    assert.object(opts.registration, 'options.registration');
    assert.object(opts.zk, 'options.zk');
    assert.func(cb, 'callback');

    var path = domainToPath(opts.domain);

    // We always write a leadnode for ourselves.
    var aliases = [ path + '/' + HOSTNAME ];

    var oaliases = opts.registration.aliases || [];
    for (var i = 0; i < oaliases.length; ++i) {
        var p = domainToPath(oaliases[i]);
        aliases.push(p);
    }

    LOG.debug({
        domain: opts.domain,
        registration: opts.registration,
        path: path,
        aliases: aliases
    }, 'registering');

    // Register $self in ZK depending on the type.
    vasync.pipeline({
        arg: {
            aliases: aliases,
            config: opts.config,
            domain: opts.domain,
            log: LOG,
            path: path,
            registration: opts.registration,
            zk: opts.zk
        },
        funcs: [
            removeOldEntries,
            function wait(_, _cb) {
                LOG.info('waiting for 1s');
                setTimeout(_cb.bind(null), 1000);
            },
            registerEntries,
            registerService
        ]
    }, function (err) {
        if (err) {
            LOG.error(err, 'unable to register in ZooKeeper');
            NODES.length = 0;
            cb(err);
        } else {
            LOG.info('registered in ZooKeeper');
            cb();
        }
    });
}



///--- Mainline

(function main() {
    var argv;
    try {
        argv = dashdash.createParser({options: OPTIONS}).parse(process.argv);
    } catch (e) {
        console.error('foo: error: %s', e.message);
        process.exit(1);
    }
    if (argv.help)
        usage();

    var cfg = readConfig(argv);

    createZkClient(cfg.zookeeper, function onZooKeeperClient(init_err, zk) {
        if (init_err) {
            LOG.fatal(init_err, 'unable to create ZooKeeper client');
            process.exit(1);
        }

        zk.on('connect', function () {
            LOG.info('ZooKeeper: connection reestablished');
        });

        var rOpts =  {
            config: cfg,
            domain: cfg.registration.domain,
            log: LOG,
            registration: cfg.registration,
            zk: zk
        };

        var hCfg = cfg.heartbeat || {};
        var retry = backoff.call(register, rOpts, function (err, res) {
            if (err) {
                LOG.fatal(err, 'registration failed');
                process.exit(1);
            }

            var interval = cfg.heartbeatInterval || 30000;
            function checkNodes() {
                var opts = {
                    config: hCfg,
                    log: LOG,
                    nodes: NODES,
                    zk: zk
                };
                heartbeat(opts, function (check_err) {
                    if (check_err) {
                        LOG.fatal({
                            err: check_err,
                            nodes: NODES
                        }, 'unable to see nodes in ZK');
                        process.exit(1);
                    }

                    LOG.debug('heartbeat of %j ok', NODES);
                    setTimeout(checkNodes, interval);
                });
            }

            setTimeout(checkNodes, interval);
        });
        retry.failAfter(hCfg.maxAttempts || 30);
        retry.setStrategy(new backoff.ExponentialStrategy({
            initialDelay: hCfg.initialDelay || 1000,
            maxDelay: hCfg.maxDelay || 30000
        }));
        retry.start();
    });


})();
