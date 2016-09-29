if (typeof require !== 'undefined') {
  var weightSort = require('weight-sort')
  var async = require('async')
  var BoundingBox = require('boundingbox')
  var keys = Object.keys || require('object-keys')

  var httpLoad = require('./httpLoad')
  var removeNullEntries = require('./removeNullEntries')

  var OverpassObject = require('./OverpassObject')
  var OverpassNode = require('./OverpassNode')
  var OverpassWay = require('./OverpassWay')
  var OverpassRelation = require('./OverpassRelation')
  var OverpassRequest = require('./OverpassRequest')
}

function OverpassFrontend (url, options) {
  this.url = url
  this.options = {
    effortPerRequest: 1000,
    effortNode: 1,
    effortWay: 4,
    effortRelation: 64,
    timeGap: 10
  }
  for (var k in options) {
    this.options[k] = options[k]
  }

  this.overpassElements = {}
  this.overpassElements_member_of = {}
  this.overpassTiles = {}
  this.overpassRequests = []
  this.overpassRequestActive = false
  this.overpassBBoxQueryCache = {}
}

// Defines
OverpassFrontend.ID_ONLY = 0
OverpassFrontend.TAGS = 1
OverpassFrontend.META = 2
OverpassFrontend.MEMBERS = 4
OverpassFrontend.BBOX = 8
OverpassFrontend.GEOM = 16
OverpassFrontend.CENTER = 32
OverpassFrontend.ALL = 63
OverpassFrontend.DEFAULT = 13

OverpassFrontend.prototype.get = function (ids, options, featureCallback, finalCallback) {
  if (typeof ids === 'string') {
    ids = [ ids ]
  }
  if (options === null) {
    options = {}
  }
  if (typeof options.properties === 'undefined') {
    options.properties = OverpassFrontend.DEFAULT
  }

  for (var i = 0; i < ids.length; i++) {
    if (ids[i] in this.overpassElements && this.overpassElements[ids[i]] === false) {
      delete this.overpassElements[ids[i]]
    }
  }

  if (options.bbox) {
    options.bbox = new BoundingBox(options.bbox)
  }

  var request = new OverpassRequest(this, {
    type: 'get',
    ids: ids,
    options: options,
    priority: 'priority' in options ? options.priority : 0,
    featureCallback: featureCallback,
    finalCallback: finalCallback
  })

  this.overpassRequests.push(request)

  this.overpassRequests = removeNullEntries(this.overpassRequests)
  this.overpassRequests = weightSort(this.overpassRequests, 'priority')

  this._overpass_process()

  return request
}

OverpassFrontend.prototype._overpass_process = function () {
  if (this.overpassRequestActive) {
    return
  }

  if (!this.overpassRequests.length) {
    return
  }

  this.overpassRequestActive = true
  var effort = 0
  var context = {
    todo: {},
    BBoxTodo: {},
    todoRequests: {}
  }
  var todoCallbacks = []
  var query = ''
  var request

  if (this.overpassRequests[0].type === 'BBoxQuery') {
    request = this.overpassRequests.splice(0, 1)
    return this._overpass_process_query(request[0])
  }

  for (var j = 0; j < this.overpassRequests.length; j++) {
    request = this.overpassRequests[j]

    if (request.type !== 'get') {
      continue
    }

    var ids = request.ids
    var allFoundUntilNow = true
    var nodeQuery = ''
    var wayQuery = ''
    var relationQuery = ''
    var BBoxQuery = ''

    if (request.options.bbox) {
      BBoxQuery = request.options.bbox.toBBoxString()
      BBoxQuery = BBoxQuery.split(/,/)
      BBoxQuery = '(' + BBoxQuery[1] + ',' + BBoxQuery[0] + ',' +
                    BBoxQuery[3] + ',' + BBoxQuery[2] + ')'
    }

    if (!ids) {
      ids = []
    }

    for (var i = 0; i < ids.length; i++) {
      if (ids[i] === null) {
        continue
      }

      if (ids[i] in this.overpassElements) {
        var ob = this.overpassElements[ids[i]]
        var ready = true

        // for bbox option, if object is (partly) loaded, but outside call
        // featureCallback with 'false'
        if (request.options.bbox && ob.bounds && !request.options.bbox.intersects(ob.bounds)) {
          todoCallbacks.push([ request.featureCallback, false, i ])
          request.ids[i] = null
          continue
        }

        // not fully loaded
        if ((ob !== false && ob !== null) && (request.options.properties & ob.properties) !== request.options.properties) {
          ready = false
        }

        // if callOrdered is set in options maybe defer calling featureCallback
        if ((!('callOrdered' in request.options) ||
           (request.options.callOrdered && allFoundUntilNow)) && ready) {
          todoCallbacks.push([ request.featureCallback, ob, i ])
          request.ids[i] = null
        }

        if (ready) {
          continue
        }
      }

      allFoundUntilNow = false
      if (ids[i] in context.todo) {
        continue
      }

      // too much data - delay for next iteration
      if (effort >= this.options.effortPerRequest) {
        continue
      }

      if (request.options.bbox) {
        // check if we already know the bbox of the element; if yes, don't try
        // to load object if it does not intersect bounds
        if (ids[i] in this.overpassElements && (this.overpassElements[ids[i]].properties & OverpassFrontend.BBOX)) {
          if (!request.options.bbox.intersects(this.overpassElements[ids[i]].bounds)) {
            continue
          }
        }

        context.todo[ids[i]] = true
        context.todoRequests[ids[i]] = request
        context.BBoxTodo[ids[i]] = true
      } else {
        context.todo[ids[i]] = true
        context.todoRequests[ids[i]] = request
      }

      switch (ids[i].substr(0, 1)) {
        case 'n':
          nodeQuery += 'node(' + ids[i].substr(1) + ');\n'
          effort += this.options.effortNode
          break
        case 'w':
          wayQuery += 'way(' + ids[i].substr(1) + ');\n'
          effort += this.options.effortWay
          break
        case 'r':
          relationQuery += 'relation(' + ids[i].substr(1) + ');\n'
          effort += this.options.effortRelation
          break
      }
    }

    if (allFoundUntilNow) {
      todoCallbacks.push([ request.finalCallback, null, null ])
      this.overpassRequests[j] = null
    }

    var outOptions = overpassOutOptions(request.options)

    if (nodeQuery !== '') {
      query += '((' + nodeQuery + ');)->.n;\n'
      if (BBoxQuery) {
        query += '(node.n; - node.n' + BBoxQuery + '->.n);\nout ids bb qt;\n'
      }
      query += '.n out ' + outOptions + ';\n'
    }

    if (wayQuery !== '') {
      query += '((' + wayQuery + ');)->.w;\n'
      if (BBoxQuery) {
        query += '(way.w; - way.w' + BBoxQuery + '->.w);\nout ids bb qt;\n'
      }
      query += '.w out ' + outOptions + ';\n'
    }

    if (relationQuery !== '') {
      query += '((' + relationQuery + ');)->.r;\n'
      if (BBoxQuery) {
        query += '(relation.r; - relation.r' + BBoxQuery + '->.r);\nout ids bb qt;\n'
      }
      query += '.r out ' + outOptions + ';\n'
    }
  }

  async.setImmediate(function () {
    for (var i = 0; i < todoCallbacks.length; i++) {
      var c = todoCallbacks[i]

      c[0](null, c[1], c[2])
    }
  })

  removeNullEntries(this.overpassRequests)

  if (query === '') {
    this.overpassRequestActive = false
    return
  }

  setTimeout(function () {
    httpLoad(
      this.url,
      null,
      '[out:json];\n' + query,
      this._overpass_handle_result.bind(this, context)
    )
  }.bind(this), this.options.timeGap)
}

OverpassFrontend.prototype._overpass_handle_result = function (context, err, results) {
  var el
  var id

  if (err) {
    var done = []

    for (var k in context.todoRequests) {
      var request = context.todoRequests[k]

      if (done.indexOf(request) === -1) {
        // call finalCallback for the request
        request.finalCallback(err)
        // remove current request
        this.overpassRequests[this.overpassRequests.indexOf(request)] = null
        // we already handled this request
        done.push(request)
      }
    }

    this.overpassRequestActive = false
    return
  }

  for (var i = 0; i < results.elements.length; i++) {
    el = results.elements[i]
    id = el.type.substr(0, 1) + el.id
    request = context.todoRequests[id]

    // bounding box only result -> save to overpassElements with bounds only
    if (request.options.bbox) {
      var elBBox = new BoundingBox(el)

      if (!request.options.bbox.intersects(elBBox)) {
        var BBoxRequest = {
          options: {
            properties: OverpassFrontend.BBOX
          }
        }

        this.createOrUpdateOSMObject(el, BBoxRequest)

        continue
      }
    }

    this.createOrUpdateOSMObject(el, request)

    var members = this.overpassElements[id].member_ids()
    if (members) {
      for (var j = 0; j < members.length; j++) {
        if (!(members[j] in this.overpassElements_member_of)) {
          this.overpassElements_member_of[members[j]] = [ this.overpassElements[id] ]
        } else {
          this.overpassElements_member_of[members[j]].push(this.overpassElements[id])
        }
      }
    }
  }

  for (id in context.todo) {
    if (!(id in this.overpassElements)) {
      if (id in context.BBoxTodo) {
        this.overpassElements[id] = false
      } else {
        this.overpassElements[id] = null
      }
    }
  }

  this.overpassRequestActive = false

  this._overpass_process()
}

/**
 * @param {string} query - Query for requesting objects from Overpass API, e.g. "node[amenity=restaurant]"
 * @param {L.latLngBounds} bounds - A Leaflet Bounds object, e.g. from map.getBounds()
 * @param {object} options
 * @param {number} [options.priority=0] - Priority for loading these objects. The lower the sooner they will be requested.
 * @param {boolean} [options.orderApproxRouteLength=false] - Order objects by approximate route length (calculated from the bounding box diagonal)
 * @param {boolean} [options.callOrdered=false] - When set to true, the function featureCallback will be called in some particular order (e.g. from orderApproxRouteLength).
 * @param {function} featureCallback Will be called for each object in the order of the IDs in parameter 'ids'. Will be passed: 1. err (if an error occured, otherwise null), 2. the object or null.
 * @param {function} finalCallback Will be called after the last feature. Will be passed: 1. err (if an error occured, otherwise null).
 */
OverpassFrontend.prototype.BBoxQuery = function (query, bounds, options, featureCallback, finalCallback) {
  var boundsOptions = {
    properties: OverpassFrontend.ID_ONLY | OverpassFrontend.BBOX,
    orderApproxRouteLength: options.orderApproxRouteLength
  }

  bounds = new BoundingBox(bounds)

  var tileBounds = bounds.toTile()
  var cacheId = tileBounds.toBBoxString()

  // check if we have a result for this tile
  if (query in this.overpassBBoxQueryCache) {
    if (cacheId in this.overpassBBoxQueryCache[query]) {
      var todo = _overpassProcessQueryBBoxGrep(this.overpassBBoxQueryCache[query][cacheId], bounds)

      if (options.orderApproxRouteLength) {
        todo = weightSort(todo)
      }

      return this.get(keys(todo), options, featureCallback, finalCallback)
    }
  } else {
    this.overpassBBoxQueryCache[query] = {}
  }

  var request = new OverpassRequest(this, {
    type: 'BBoxQuery',
    query: query,
    bounds: bounds,
    tileBounds: tileBounds,
    cacheId: cacheId,
    options: boundsOptions,
    get_options: options,
    priority: 'priority' in options ? options.priority : 0,
    featureCallback: featureCallback,
    finalCallback: finalCallback
  })

  this.overpassRequests.push(request)

  removeNullEntries(this.overpassRequests)
  this.overpassRequests = weightSort(this.overpassRequests, 'priority')

  this._overpass_process()

  return request
}

OverpassFrontend.prototype._overpass_process_query = function (request) {
  var BBoxString = request.tileBounds.toBBoxString()
  BBoxString = BBoxString.split(/,/)
  BBoxString = BBoxString[1] + ',' + BBoxString[0] + ',' +
                BBoxString[3] + ',' + BBoxString[2]

  var queryOptions = '[bbox:' + BBoxString + ']'
  var query = request.query

  var context = {
    request: request
  }

  setTimeout(function () {
    httpLoad(
      this.url,
      null,
      '[out:json]' + queryOptions + ';\n' + query + '\nout ' + overpassOutOptions(request.options) + ';',
      this._overpass_handle_process_query.bind(this, context)
    )
  }.bind(this), this.options.timeGap)
}

OverpassFrontend.prototype._overpass_handle_process_query = function (context, err, results) {
  var request = context.request

  if (err) {
    // call finalCallback for the request
    request.finalCallback(err)
    // remove current request
    this.overpassRequests[this.overpassRequests.indexOf(request)] = null
    this.overpassRequestActive = false

    return
  }

  this.overpassBBoxQueryCache[request.query][request.cacheId] = {}

  for (var i = 0; i < results.elements.length; i++) {
    var el = results.elements[i]
    var id = el.type.substr(0, 1) + el.id

    var obBBox = new BoundingBox(el)
    var approxRouteLength = obBBox.diagonalLength(obBBox)

    this.overpassBBoxQueryCache[request.query][request.cacheId][id] = {
      bounds: obBBox,
      approxRouteLength: approxRouteLength
    }
  }

  var todo = _overpassProcessQueryBBoxGrep(this.overpassBBoxQueryCache[request.query][request.cacheId], request.bounds)

  if (request.options.orderApproxRouteLength) {
    todo = weightSort(todo, 'approxRouteLength')
  }

  this.get(keys(todo), request.get_options, request.featureCallback, request.finalCallback)

  this.overpassRequestActive = false

  this._overpass_process()
}

OverpassFrontend.prototype.abortAllRequests = function () {
  for (var j = 0; j < this.overpassRequests.length; j++) {
    if (this.overpassRequests[j] === null) {
      continue
    }

    this.overpassRequests[j].finalCallback('abort')
  }

  this.overpassRequests = []
}

OverpassFrontend.prototype.removeFromCache = function (ids) {
  if (typeof ids === 'string') {
    ids = [ ids ]
  }

  for (var i = 0; i < ids.length; i++) {
    delete this.overpassElements[ids[i]]
  }
}

OverpassFrontend.prototype.createOrUpdateOSMObject = function (el, request) {
  var id = el.type.substr(0, 1) + el.id
  var ob = null

  if (id in this.overpassElements) {
    ob = this.overpassElements[id]
  } else if (el.type === 'relation') {
    ob = new OverpassRelation(id)
  } else if (el.type === 'way') {
    ob = new OverpassWay(id)
  } else if (el.type === 'node') {
    ob = new OverpassNode(id)
  } else {
    ob = new OverpassObject(id)
  }

  ob.updateData(el, request)

  this.overpassElements[id] = ob
}

OverpassFrontend.prototype.regexpEscape = function (str) {
  return str.replace('\\', '\\\\')
       .replace('.', '\\.')
       .replace('|', '\\|')
       .replace('[', '\\[')
       .replace(']', '\\]')
       .replace('(', '\\(')
       .replace(')', '\\)')
       .replace('{', '\\{')
       .replace('}', '\\}')
       .replace('?', '\\?')
       .replace('+', '\\+')
       .replace('*', '\\*')
       .replace('^', '\\^')
       .replace('$', '\\$')
}

function overpassOutOptions (options) {
  var outOptions = ''

  if (options.properties & OverpassFrontend.META) {
    outOptions += 'meta '
  } else if (options.properties & OverpassFrontend.TAGS) {
    if (options.properties & OverpassFrontend.MEMBERS) {
      outOptions += 'body '
    } else {
      outOptions += 'tags '
    }
  } else if (options.properties & OverpassFrontend.MEMBERS) {
    outOptions += 'skel '
  } else {
    outOptions += 'ids '
  }

  if (options.properties & OverpassFrontend.GEOM) {
    outOptions += 'geom '
  } else if (options.properties & OverpassFrontend.BBOX) {
    outOptions += 'bb '
  } else if (options.properties & OverpassFrontend.CENTER) {
    outOptions += 'center '
  }

  outOptions += 'qt'

  return outOptions
}

function _overpassProcessQueryBBoxGrep (elements, bbox) {
  var ret = {}

  for (var id in elements) {
    if (bbox.intersects(elements[id].bounds)) {
      ret[id] = elements[id]
    }
  }

  return ret
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OverpassFrontend
}
if (typeof window !== 'undefined') {
  window.OverpassFrontend = OverpassFrontend
}