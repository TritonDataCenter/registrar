// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var fs = require('fs');
var os = require('os');

var assert = require('assert-plus');
var backoff = require('backoff');
var bunyan = require('bunyan');
var clone = require('clone');
var getopt = require('posix-getopt');
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



///--- CLI Helpers

function parseOptions() {
        var option;
        var opts = {};
        var parser = new getopt.BasicParser('vf:(file)', process.argv);

        while ((option = parser.getopt()) !== undefined) {
                switch (option.option) {
                case 'f':
                        opts.file = option.optarg;
                        break;

                case 'v':
                        // Allows us to set -vvv -> this little hackery
                        // just ensures that we're never < TRACE
                        LOG.level(Math.max(bunyan.TRACE, (LOG.level() - 10)));
                        if (LOG.level() <= bunyan.DEBUG)
                                LOG = LOG.child({src: true});
                        break;

                default:
                        console.error('invalid option: ' + option.option);
                        process.exit(1);
                        break;
                }
        }

        return (opts);
}


function readConfig(opts) {
        assert.object(opts, 'options');
        assert.string(opts.file, 'options.file');

        var cfg;
        var f = opts.file;
        var _file;
        try {
                _file = fs.readFileSync(f, 'utf8');
        } catch (e) {
                LOG.fatal(e, 'unable to read configuration %s', f);
                process.exit(1);
        }

        try {
                cfg = JSON.parse(_file);
        } catch (e) {
                LOG.fatal(e, 'invalid JSON in %s', f);
                process.exit(1);
        }

        LOG.info(cfg, 'configuration loaded from %s', f);

        return (cfg);
}


function usage(msg) {
        if (msg)
                console.error(msg);

        var str = 'usage: ' + require('path').basename(process.argv[1]);
        str += '[-v] [-f file]';
        console.error(str);
        process.exit(1);
}



///--- worker functions

function address() {
        if (CFG.adminIp)
                return (CFG.adminIp);

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

        return (retry);
}


function domainToPath(domain) {
        assert.string(domain, 'domain');

        // 1.moray.sds.joyent.com) => /com/joyent/sds/moray/1
        return ('/' + domain.split('.').reverse().join('/'));
}


function heartbeat(zk, cb) {
        assert.object(zk, 'zkClient');
        assert.func(cb, 'callback');

        var path = domainToPath(CFG.registration.domain);

        LOG.debug({path: path}, 'heartbeat: entered');

        zk.stat(path, function (err, stat) {
                if (err) {
                        LOG.warn({
                                err: err,
                                path: path
                        }, 'heartbeat: failed');
                        cb(err);
                } else {
                        LOG.debug({path: path}, 'heartbeat: ok');
                        cb();
                }
        });
}


function registerSelf(opts, cb) {
        assert.object(opts, 'options');
        assert.object(opts.cfg, 'options.cfg');
        assert.string(opts.cfg.domain, 'options.cfg.domain');
        assert.string(opts.domain, 'options.domain');
        assert.object(opts.log, 'options.log');
        assert.string(opts.path, 'options.path');
        assert.object(opts.zk, 'options.zk');
        assert.func(cb, 'callback');

        var cfg = opts.cfg;
        var domain = opts.domain;
        var log = opts.log;
        var path = opts.path + '/' + HOSTNAME;
        var zk = opts.zk;

        log.debug({
                domain: domain,
                hostname: HOSTNAME,
                path: path
        }, 'registerSelf: entered');

        zk.mkdirp(opts.path, function (err) {
                if (err) {
                        log.error({
                                domain: domain,
                                hostname: HOSTNAME,
                                path: opts.path,
                                err: err
                        }, 'registerSelf: zk.mkdirp failed');
                        cb(err);
                        return;
                }

                log.debug({
                        domain: domain,
                        hostname: HOSTNAME,
                        path: opts.path
                }, 'registerSelf: zk.mkdirp done');

                var options = {
                        flags: ['ephemeral'],
                        object: {
                                type: cfg.type
                        }
                };
                options.object[cfg.type] = {
                        address: address()
                };
                if (typeof (cfg.ttl) === 'number')
                        options.object.ttl = cfg.ttl;

                zk.creat(path, options, function (err2) {
                        if (err2 && err2.code !== zkplus.ZNODEEXISTS) {
                                log.error({
                                        domain: domain,
                                        hostname: HOSTNAME,
                                        path: path,
                                        err: err
                                }, 'registerSelf: zk.creat failed');
                                cb(err2);
                                return;
                        }

                        log.info({
                                domain: domain,
                                hostname: HOSTNAME,
                                path: path,
                                data: options
                        }, 'registerSelf: done');
                        cb();
                });
        });
}


function registerService(opts, cb) {
        assert.object(opts, 'options');
        assert.object(opts.cfg, 'options.cfg');
        assert.string(opts.cfg.domain, 'options.cfg.domain');
        assert.string(opts.domain, 'options.domain');
        assert.object(opts.log, 'options.log');
        assert.string(opts.path, 'options.path');
        assert.object(opts.zk, 'options.zk');
        assert.func(cb, 'callback');

        if (!opts.cfg.service) {
                cb();
                return;
        }

        var cfg = opts.cfg;
        var domain = opts.cfg.domain;
        var log = opts.log;
        var path = opts.path;
        var zk = opts.zk;

        log.debug({
                domain: domain,
                path: path
        }, 'registerService: entered');

        var obj = {
                type: 'service',
                service: cfg.service
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
                        cb();
                }
        });
}


function removeOldEntry(opts, cb) {
        assert.object(opts, 'options');
        assert.string(opts.domain, 'opts.domain');
        assert.object(opts.log, 'options.log');
        assert.string(opts.path, 'options.lopath');
        assert.object(opts.zk, 'options.zk');
        assert.func(cb, 'callback');

        var log = opts.log;
        var path = opts.path + '/' + HOSTNAME;
        var zk = opts.zk;

        log.debug({
                domain: opts.cfg.domain,
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
}


function register(opts) {
        assert.object(opts, 'options');
        assert.string(opts.domain, 'options.domain');
        assert.object(opts.registration, 'options.registration');
        assert.object(opts.zk, 'options.zk');

        var path = domainToPath(opts.domain);

        LOG.debug({
                domain: opts.domain,
                registration: opts.registration,
                path: path
        }, 'registering');

        // register $self in ZK depending on the type. We always
        // write a leadnode for ourselves, but we may need to additionally
        // set a service record.
        vasync.pipeline({
                arg: {
                        cfg: opts.registration,
                        domain: opts.domain,
                        log: LOG,
                        path: path,
                        zk: opts.zk
                },
                funcs: [
                        removeOldEntry,
                        function sleepForTickTime(_, cb) {
                                LOG.info('waiting for 1s');
                                setTimeout(cb.bind(null), 1000);
                        },
                        registerSelf,
                        registerService
                ]
        }, function (err) {
                if (err) {
                        LOG.error(err, 'unable to register in ZooKeeper');
                } else {
                        LOG.info('registered in ZooKeeper');
                }
        });
}



///--- Mainline

var ARGV = parseOptions();
var CFG = readConfig(ARGV);
CFG.zookeeper.log = LOG;

createZkClient(CFG.zookeeper, function onZooKeeperClient(init_err, zk) {
        if (init_err) {
                LOG.fatal(init_err, 'unable to create ZooKeeper client');
                process.exit(1);
        }

        zk.on('error', function (err) {
                LOG.fatal(err, 'Unexpected ZK error');
                process.exit(1);
        });

        zk.on('connection_interrupted', function () {
                LOG.warni('ZooKeeper: connection loss');
        });

        zk.on('connect', function () {
                LOG.info('ZooKeeper: reconnected');
        });

        register({
                domain: CFG.registration.domain,
                log: LOG,
                registration: CFG.registration,
                zk: zk
        });
});
