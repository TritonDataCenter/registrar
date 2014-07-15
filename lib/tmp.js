
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
                address: opts.adminIp ? opts.adminIp : address()
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
    aliases(opts).forEach(function (a) {
        funcs.push(registerEntryFunc(a));
    });

    vasync.pipeline({
        funcs: funcs,
        arg: opts
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


function aliases(opts) {
    assert.object(opts, 'options');
    assert.string(opts.domain, 'options.domain');
    assert.optionalArrayOfString(opts.aliases, 'options.aliases');

    // We always write a leadnode for ourselves.
    return ([
        path.join(domainToPath(opts.domain), os.hostname())
    ].concat((opts.aliases || []).map(function (a) {
        arr.push(domainToPath(a));
    })));
}
