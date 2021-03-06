var url = require('url');
var common = require('./common.js');

var Page = function (id, url) {
    this.id = id;
    this.url = url;
    this.entries = {};
    this.startTime = undefined;
    this.endTime = undefined;
}

Page.prototype.start = function () {
    this.startTime = new Date();
}

Page.prototype.end = function () {
    this.endTime = new Date();
}

// typical sequence:
//
// Network.requestWillBeSent # about to send a request
// Network.responseReceived  # headers received
// Network.dataReceived      # data chunk received
// [...]
// Network.loadingFinished   # full response received
Page.prototype.processMessage = function (message) {
    var id = message.params.requestId;
    common.dump('<-- ' + '[' + id + '] ' + message.method);
    switch (message.method) {
        case 'Network.requestWillBeSent':
            this.entries[id] = {
                'requestEvent': message.params,
                'responseEvent': undefined,
                'responseLength': 0,
                'encodedResponseLength': 0,
                'responseFinished': undefined
            };
            break;
        case 'Network.dataReceived':
            this.entries[id].responseLength += message.params.dataLength;
            this.entries[id].encodedResponseLength += message.params.encodedDataLength;
            break;
        case 'Network.responseReceived':
            this.entries[id].responseEvent = message.params;
            break;
        case 'Network.loadingFinished':
            this.entries[id].responseFinished = message.params.timestamp;
            break;
    }
}

Page.prototype.getHAR = function () {
    var har = {
        'info': {
            'startedDateTime': this.startTime.toISOString(),
            'id': this.id.toString(),
            'title': this.url,
            'pageTimings': {
                'onLoad': this.endTime - this.startTime
            }
        },
        'entries': []
    };

    for (var requestId in this.entries) {
        var entry = this.entries[requestId];

        // skip incomplete entries
        if (!entry.responseEvent || !entry.responseFinished) continue;

        // skip entries with no timing information (it's optional)
        var timing = entry.responseEvent.response.timing;
        if (!timing) continue;

        // analyze headers
        var requestHeaders = convertHeaders(entry.requestEvent.request.headers);
        var responseHeaders = convertHeaders(entry.responseEvent.response.headers);

        // add status line length
        requestHeaders.size += (entry.requestEvent.request.method.length +
                                entry.requestEvent.request.url.length +
                                12); // "HTTP/1.x" + "  " + "\r\n"

        responseHeaders.size += (entry.responseEvent.response.status.toString().length +
                                 entry.responseEvent.response.statusText.length +
                                 12); // "HTTP/1.x" + "  " + "\r\n"

        // query string
        var queryString = convertQueryString(entry.requestEvent.request.url);

        // compute timing informations: input
        var dnsTime = timeDelta(timing.dnsStart, timing.dnsEnd);
        var proxyTime = timeDelta(timing.proxyStart, timing.proxyEnd);
        var connectTime = timeDelta(timing.connectStart, timing.connectEnd);
        var sslTime = timeDelta(timing.sslStart, timing.sslEnd);
        var sendTime = timeDelta(timing.sendStart, timing.sendEnd);

        // compute timing informations: output
        var totalTime = Math.round((entry.responseFinished - timing.requestTime) * 1000);
        var dns = dnsTime;
        var connect = proxyTime + connectTime;
        var ssl = sslTime;
        var send = sendTime;
        var wait = timing.receiveHeadersEnd - timing.sendEnd;
        var receive = totalTime - timing.receiveHeadersEnd;
        var blocked = totalTime - (dns + connect + send + wait + receive + ssl);

        // fill entry
        har.entries.push({
            'pageref': this.id.toString(),
            'startedDateTime': new Date(timing.requestTime * 1000).toISOString(),
            'time': totalTime,
            'request': {
                'method': entry.requestEvent.request.method,
                'url': entry.requestEvent.request.url,
                'httpVersion': 'HTTP/1.1', // TODO
                'cookies': [], // TODO
                'headers': requestHeaders.pairs,
                'queryString': queryString,
                'headersSize': requestHeaders.size,
                'bodySize': entry.requestEvent.request.headers['Content-Length'] || -1,
            },
            'response': {
                'status': entry.responseEvent.response.status,
                'statusText': entry.responseEvent.response.statusText,
                'httpVersion': 'HTTP/1.1', // TODO
                'cookies': [], // TODO
                'headers': responseHeaders.pairs,
                'redirectURL': '', // TODO
                'headersSize': responseHeaders.size,
                'bodySize': entry.encodedResponseLength,
                'content': {
                    'size': entry.responseLength,
                    'mimeType': entry.responseEvent.response.mimeType,
                    'compression': entry.responseLength - entry.encodedResponseLength
                }
            },
            'cache': {},
            'timings': {
                'blocked': blocked,
                'dns': dns,
                'connect': connect,
                'send': send,
                'wait': wait,
                'receive': receive,
                'ssl': ssl
            }
        });
    }

    return har;
}

function convertQueryString(fullUrl) {
    var query = url.parse(fullUrl, true).query;
    var pairs = [];
    for (var name in query) {
        var value = query[name];
        pairs.push({'name': name, 'value': value.toString()});
    }
    return pairs;
}

function convertHeaders(headers) {
    headersObject = {'pairs': [], 'size': -1};
    if (Object.keys(headers).length) {
        headersObject.size = 2; // trailing "\r\n"
        for (var name in headers) {
            var value = headers[name];
            headersObject.pairs.push({'name': name, 'value': value});
            headersObject.size += name.length + value.length + 4; // ": " + "\r\n"
        }
    }
    return headersObject;
}

function timeDelta(start, end) {
    return start != -1 && end != -1 ? (end - start) : 0;
}

module.exports = Page;
