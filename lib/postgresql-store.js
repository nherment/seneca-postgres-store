/*jslint node: true*/
/*jslint asi: true */
/* Copyright (c) 2012-2013 Marian Radulescu */
"use strict";

var _ = require('underscore');
var pg = require('pg');
var util = require('util')
var uuid = require('node-uuid');
var relationalstore = require('./relational-util')

var name = 'postgresql-store';

var MIN_WAIT = 16
var MAX_WAIT = 5000

module.exports = function (opts) {

  var seneca = this;

  opts.minwait = opts.minwait || MIN_WAIT
  opts.maxwait = opts.maxwait || MAX_WAIT

  var minwait
  var dbinst = null

  function error(query, args, err, cb) {
    if (err) {
      var errorDetails = {
        message: err.message,
        err: err,
        stack: err.stack,
        query: query
      }
      seneca.log.error('Query Failed', JSON.stringify(errorDetails, null, 1))
      seneca.fail({code: 'entity/error', store: name}, cb)

      if ('ECONNREFUSED' == err.code || 'notConnected' == err.message || 'Error: no open connections' == err) {
        minwait = opts.minwait
        if (minwait) {
          reconnect(args)
        }
      }

      return true
    }

    return false
  }


  function reconnect(args) {
    seneca.log.debug('attempting db reconnect')

    configure(opts, function (err) {
      if (err) {
        seneca.log.debug('db reconnect (wait ' + opts.minwait + 'ms) failed: ' + err)
        minwait = Math.min(2 * minwait, opts.maxwait)
        setTimeout(function () {
          reconnect(args)
        }, minwait)
      } else {
        minwait = opts.minwait
        seneca.log.debug('reconnect ok')
      }
    })
  }

  var pgConf;
  function configure(spec, cb) {

    pgConf = 'string' === typeof(spec) ? null : spec

    if (!pgConf) {
      pgConf = {}

      var urlM = /^postgres:\/\/((.*?):(.*?)@)?(.*?)(:?(\d+))?\/(.*?)$/.exec(spec);
      pgConf.name = urlM[7]
      pgConf.port = urlM[6]
      pgConf.host = urlM[4]
      pgConf.username = urlM[2]
      pgConf.password = urlM[3]

      pgConf.port = pgConf.port ? parseInt(pgConf.port, 10) : null
    }

    // pg conf properties
    pgConf.user = pgConf.username
    pgConf.database = pgConf.name

    pgConf.host     = pgConf.host || pgConf.server
    pgConf.username = pgConf.username || pgConf.user
    pgConf.password = pgConf.password || pgConf.pass

    setImmediate(function() {
      cb(undefined)
    })
  }

  function execQuery(query, callback) {
    pg.connect(pgConf, function(err, client, releaseConnection) {
      if(err) {
        seneca.log.error('Connection error', err)
        callback(err, undefined)
      } else {
        if(!query) {
          err = new Error('Query cannot be empty')
          seneca.log.error('An empty query is not a valid query', err)
          releaseConnection()
          return callback(err, undefined)
        }
        client.query(query, function (err, res) {
          releaseConnection()
          callback(err, res)
        })
      }
    })
  }


  var store = {

    name: name,

    close: function (cb) {
      // if (dbinst) {
      //   dbinst.end(cb)
      // }
    },


    save: function (args, cb) {
      var ent = args.ent
      var query;
      var update = !!ent.id;

      if (update) {
        query = updatestm(ent)
        execQuery(query, function (err, res) {
          if (!error(query, args, err, cb)) {
            seneca.log(args.tag$, 'update', ent)
            cb(null, ent)
          }
          else {
            seneca.fail({code: 'update', tag: args.tag$, store: store.name, query: query, error: err}, cb)
          }
        })
      }
      else {
        ent.id = ent.id$ || uuid()

        query = savestm(ent)

        execQuery(query, function (err, res) {
          if (!error(query, args, err, cb)) {
            seneca.log(args.tag$, 'save', ent)
            cb(null, ent)
          }
          else {
            seneca.log.error(query.text, query.values, err)
            seneca.fail({code: 'save', tag: args.tag$, store: store.name, query: query, error: err}, cb)
          }
        })
      }
    },


    load: function (args, cb) {
      var qent = args.qent
      var q = args.q

      var query = selectstm(qent, q)
      var trace = new Error()
      execQuery(query, function (err, res) {
        if (!error(query, args, err, cb)) {
          var ent
          if(res.rows && res.rows.length > 0) {
            ent = relationalstore.makeent(qent, res.rows[0])
          }
          seneca.log(args.tag$, 'load', ent)
          cb(null, ent)
        }
        else {
          seneca.log.error(query.text, query.values, trace.stack)
          seneca.fail({code: 'load', tag: args.tag$, store: store.name, query: query, error: err}, cb)
        }
      })
    },


    list: function (args, cb) {
      var qent = args.qent
      var q = args.q

      var list = []

      var query

      if(q.distinct$) {
        query = distinctStatement(qent, q)
      } else if(q.ids) {
        query = selectstmOr(qent, q)
      } else {
        query = selectstm(qent, q)
      }

      execQuery(query, function (err, res) {
        if (!error(query, args, err, cb)) {
          res.rows.forEach(function (row) {
            var ent = relationalstore.makeent(qent, row)
            list.push(ent)
          })
          seneca.log(args.tag$, 'list', list.length, list[0])
          cb(null, list)
        }
        else {
          seneca.fail({code: 'list', tag: args.tag$, store: store.name, query: query, error: err}, cb)
        }
      })
    },


    remove: function (args, cb) {
      var qent = args.qent
      var q = args.q

      if (q.all$) {
        var query = deletestm(qent, q)

        execQuery(query, function (err, res) {
          if (!error(query, args, err, cb)) {
            seneca.log(args.tag$, 'remove', res.rowCount)
            cb(null, res.rowCount)
          }
          else {
            cb(err || new Error('no candidate for deletion'), undefined)
          }
        })
      }
      else {
        var selectQuery = selectstm(qent, q)

        execQuery(selectQuery, function (err, res) {
          if (!error(selectQuery, args, err, cb)) {

            var entp = res.rows[0]

            if(!entp) {
              cb(new Error('no candidate for deletion'), undefined)
            } else {

              var query = deletestm(qent, {id: entp.id})

              execQuery(query, function (err, res) {
                if (!err) {
                  seneca.log(args.tag$, 'remove', res.rowCount)
                  cb(null, res.rowCount)
                }
                else {
                  cb(err, undefined)
                }
              })
            }
          } else {

            var errorDetails = {
              message: err.message,
              err: err,
              stack: err.stack,
              query: query
            }
            seneca.log.error('Query Failed', JSON.stringify(errorDetails, null, 1))
            callback(err, undefined)
          }
        })
      }
    },


    native: function (args, done) {
//      dbinst.collection('seneca', function(err,coll){
//        if( !error(args,err,cb) ) {
//          coll.findOne({},{},function(err,entp){
//            if( !error(args,err,cb) ) {
//              done(null,dbinst)
//            }else{
//              done(err)
//            }
//          })
//        }else{
//          done(err)
//        }
//      })
    }

  }


  var savestm = function (ent) {
    var stm = {}

    var table = relationalstore.tablename(ent)
    var entp = relationalstore.makeentp(ent)
    var fields = _.keys(entp)

    var values = []
    var params = []

    var cnt = 0

    var escapedFields = []
    fields.forEach(function (field) {
      escapedFields.push('"' + escapeStr(field) + '"')
      values.push(entp[field])
      params.push('$' + (++cnt))
    })

    stm.text = 'INSERT INTO ' + escapeStr(table) + ' (' + escapedFields + ') values (' + escapeStr(params) + ')'
    stm.values = values

    return stm
  }


  var updatestm = function (ent) {
    var stm = {}

    var table = relationalstore.tablename(ent)
    var entp = relationalstore.makeentp(ent)
    var fields = _.keys(entp)

    var values = []
    var params = []
    var cnt = 0

    fields.forEach(function (field) {
      if (!_.isUndefined(entp[field])) {
        values.push(entp[field])
        params.push('"' + escapeStr(field) + '"=$' + (++cnt))
      }
    })

    stm.text = "UPDATE " + escapeStr(table) + " SET " + params + " WHERE id='" + escapeStr(ent.id) + "'"
    stm.values = values

    return stm
  }


  var deletestm = function (qent, q) {
    var stm = {}

    var table = relationalstore.tablename(qent)
    var entp = relationalstore.makeentp(qent)

    var values = []
    var params = []

    var cnt = 0

    var w = whereargs(entp, q)

    var wherestr = ''

    if (!_.isEmpty(w) && w.params.length > 0) {
      w.params.forEach(function (param) {
        params.push('"' + escapeStr(param) + '"=$' + (++cnt))
      })

      if (!_.isEmpty(w.values)) {
        w.values.forEach(function (val) {
          values.push(escapeStr(val))
        })
      }

      wherestr = " WHERE " + params.join(' AND ')
    }

    stm.text = "DELETE FROM " + escapeStr(table) + wherestr
    stm.values = values

    return stm
  }


  var distinctStatement = function (qent, q) {
    var stm = {}

    var table = relationalstore.tablename(qent)
    var entp = relationalstore.makeentp(qent)

    var values = []
    var params = []

    var cnt = 0

    var w = whereargs(entp, q)

    var wherestr = ''

    if (!_.isEmpty(w) && w.params.length > 0) {
      w.params.forEach(function (param) {
        params.push('"'+escapeStr(param) + '"=$' + (++cnt))
      })

      w.values.forEach(function (value) {
        values.push(value)
      })

      wherestr = " WHERE " + params.join(' AND ')
    }

    var mq = metaquery(qent, q)

    var metastr = ' ' + mq.params.join(' ')

    var distinctParams = q.distinct$

    var selectColumns = []
    if(distinctParams && !_.isString(distinctParams) && _.isArray(distinctParams)) {
      selectColumns = distinctParams
    }
    if(selectColumns.length === 0) {
      selectColumns.push('*')
    }

    stm.text = "SELECT DISTINCT "+ escapeStr(selectColumns.join(',')) +" FROM " + escapeStr(table) + wherestr + escapeStr(metastr)
    stm.values = values

    return stm
  }

  var selectstm = function (qent, q) {
    var stm = {}

    var table = relationalstore.tablename(qent)
    var entp = relationalstore.makeentp(qent)

    var values = []
    var params = []

    var cnt = 0

    var w = whereargs(entp, q)

    var wherestr = ''

    if (!_.isEmpty(w) && w.params.length > 0) {
      w.params.forEach(function (param, i) {
        if(w.values[i] === null) {
          // we can't use the equality on null because NULL != NULL
          w.values.splice(i, 1)
          params.push('"'+escapeStr(param) + '" IS NULL')
        } else {
          params.push('"'+escapeStr(param) + '"=$' + (++cnt))
        }
      })

      w.values.forEach(function (value) {
        values.push(value)
      })

      wherestr = " WHERE " + params.join(' AND ')
    }

    var mq = metaquery(qent, q)

    var metastr = ' ' + mq.params.join(' ')

    stm.text = "SELECT * FROM " + escapeStr(table) + wherestr + escapeStr(metastr)
    stm.values = values

    return stm
  }

   var selectstmOr = function (qent, q) {
    var stm = {}

    var table = relationalstore.tablename(qent)
    var entp = relationalstore.makeentp(qent)

    var values = []
    var params = []

    var cnt = 0

    var w = whereargs(entp, q.ids)

    var wherestr = ''

    if (!_.isEmpty(w) && w.params.length > 0) {
      w.params.forEach(function (param) {
        params.push('"'+escapeStr('id') + '"=$' + (++cnt))
      })

      w.values.forEach(function (value) {
        values.push(value)
      })

      wherestr = " WHERE " + params.join(' OR ')
    }

    //This is required to set the limit$ to be the length of the 'ids' array, so that in situations
    //when it's not set in the query(q) it won't be applied the default limit$ of 20 records
    if(!q.limit$) {
      q.limit$ = q.ids.length
    }

    var mq = metaquery(qent, q)

    var metastr = ' ' + mq.params.join(' ')

    stm.text = "SELECT * FROM " + escapeStr(table) + wherestr + escapeStr(metastr)
    stm.values = values

    return stm
  }

  var whereargs = function (entp, q) {
    var w = {}

    w.params = []
    w.values = []

    var qok = relationalstore.fixquery(entp, q)

    for (var p in qok) {
      if (qok[p] !== undefined) {
        w.params.push(p)
        w.values.push(qok[p])
      }
    }

    return w
  }


  var metaquery = function (qent, q) {
    var mq = {}

    mq.params = []
    mq.values = []

    if (q.sort$) {
      for (var sf in q.sort$) break;
      var sd = q.sort$[sf] < 0 ? 'ASC' : 'DESC'
      mq.params.push('ORDER BY ' + sf + ' ' + sd)
    }

    if (q.limit$) {
      mq.params.push('LIMIT ' + q.limit$)
    } else {
      mq.params.push('LIMIT 20')
    }

    if( q.skip$ ) {
      mq.params.push('OFFSET ' + q.skip$)
    }

    return mq
  }

  var meta = seneca.store.init(seneca, opts, store);

  seneca.add({init: store.name, tag:meta.tag}, function(args, cb) {

    configure(opts, function (err) {
      cb(err)
    })
  })
  
  return { name:store.name, tag:meta.tag };

}


var escapeStr = function(input) {
  if(input instanceof Date) {
    return input
  }
  var str = "" + input;
  return str.replace(/[\0\b\t\x08\x09\x1a\n\r"'\\\%]/g, function (char) {
    switch (char) {
      case "\0":
        return "\\0";
      case "\x08":
        return "\\b";
      case "\b":
        return "\\b";
      case "\x09":
        return "\\t";
      case "\t":
        return "\\t";
      case "\x1a":
        return "\\z";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\"":
      case "'":
      case "\\":
      case "%":
        return "\\"+char;

    }
  });
};
