var events = require('events');
var util = require('util');
var http = require('http');
var WebSocket = require('ws');
var common = require('./common.js');
var Page = require('./Page.js');

var Client = function (urls, options) {
    this.urls = urls;
    this.pages = [];
    this.currentPageIndex = -1;
    this.commandId = 1;
    this._connectToChrome(options);
}

util.inherits(Client, events.EventEmitter);

Client.prototype._connectToChrome = function (options) {
    var capturer = this;

    // defaults
    var options = options || {};
    var host = options.address || 'localhost';
    var port = options.port || 9222;
    var chooseTab = options.chooseTab || function () { return 0; };

    // fetch tab list
    var url = 'http://' + host + ':' + port + '/json';
    var request = http.get(url, function (response) {
        var data = '';
        response.on('data', function (chunk) {
            data += chunk;
        });
        response.on('end', function () {
            common.dump('Connected to Chrome: ' + url);
            var tabs = JSON.parse(data);
            var tabIndex = chooseTab(tabs);
            var tabDebuggerUrl = tabs[tabIndex].webSocketDebuggerUrl;
            capturer._connectToWebSocket(tabDebuggerUrl);
        });
    })
    request.on('error', function (error) {
        common.dump("Emitting 'error' event: " + error.message);
        capturer.emit('error');
    });
    request.end();
}

Client.prototype._connectToWebSocket = function (url) {
    var capturer = this;
    this.ws = new WebSocket(url);
    this.ws.on('open', function () {
        common.dump('Connected to WebSocket: ' + url);
        capturer._sendDebuggerCommand('Page.enable');
        capturer._sendDebuggerCommand('Network.enable');
        capturer._sendDebuggerCommand('Network.setCacheDisabled',
                                      {'cacheDisabled': true});

        // start!
        capturer._loadNextURL();
    });
    this.ws.on('message', function (data) {
        var message = JSON.parse(data);
        if (message.method) {
            var page = capturer.pages[capturer.currentPageIndex];

            // done with current URL
            if (message.method == 'Page.loadEventFired') {
                common.dump('<-- ' + message.method + ': ' + page.url);
                page.end();
                if (!capturer._loadNextURL()) {
                    common.dump("Emitting 'end' event");
                    capturer.ws.close();
                    capturer.emit('end', capturer._getHAR());
                }
            } else if (message.method.match(/^Network./)) {
                page.processMessage(message);
            } else {
                common.dump('Unhandled message: ' + message.method);
            }
        }
    });
}

Client.prototype._loadNextURL = function () {
    var id = ++this.currentPageIndex;
    var url = this.urls[id];
    if (url) {
        var page = new Page(id, url);
        page.start();
        this._sendDebuggerCommand('Page.navigate', {'url': url});
        this.pages.push(page);
    }
    return url;
}

Client.prototype._getHAR = function () {
    var har = {
        'log': {
            'version' : '1.2',
            'creator' : {
                'name': 'Chrome HAR Capturer',
                'version': '0.0.1'
            },
            'pages': [],
            'entries': []
        }
    };

    // merge pages in one HAR
    for (var i in this.pages) {
        var pageHAR = this.pages[i].getHAR();
        har.log.pages.push(pageHAR.info);
        Array.prototype.push.apply(har.log.entries, pageHAR.entries);
    }

    return har;
}

Client.prototype._sendDebuggerCommand = function (method, params) {
    common.dump('--> ' + method + ' ' + (JSON.stringify(params) || ''));
    this.ws.send(
        JSON.stringify({
            'id': this.commandId++,
            'method': method,
            'params': params
        })
    );
}

module.exports = Client;
