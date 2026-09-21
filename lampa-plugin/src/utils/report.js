// TEMPORARY (2.0.0 beta): crash reporting to Sentry.
//
// To remove: delete this file, the SEND_REPORTS key in storage.js, the two
// lang entries, the settings param and the init() call in main.js. Nothing
// else references it.
//
// No Sentry SDK on purpose: this bundle is transpiled for Chrome 37 (Android 5
// WebView) and the SDK needs a far newer runtime, while the endpoint it would
// call is one XHR with a JSON body.

import { KEYS } from './storage'
import { BUILD } from '../build'

var ENDPOINT = 'https://o4511769421152256.ingest.de.sentry.io/api/4511769432293456/store/' +
    '?sentry_version=7&sentry_client=scrob-lampa/1&sentry_key=60a21274368d2e9a6f098cd6738d1cd1'

// A reconnect loop or a failing render fires the same throw over and over; cap
// the session and drop repeats so neither the ingest nor a weak TV suffers.
var MAX_EVENTS = 25
var sent = 0
var seen = {}
var installed = false

function safe(fn) {
    try { return fn() } catch (e) { return null }
}

// Default on: the beta is the reason this exists. Storage may hand back a
// string on older Lampa builds, so compare loosely rather than trusting a type.
export function enabled() {
    var value = Lampa.Storage.get(KEYS.SEND_REPORTS, true)
    return !(value === false || value === 'false' || value === '0' || value === 0)
}

function eventId() {
    var out = ''
    for (var i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16)
    return out
}

function post(body) {
    try {
        var xhr = new XMLHttpRequest()
        xhr.open('POST', ENDPOINT, true)
        xhr.setRequestHeader('Content-Type', 'application/json')
        xhr.send(JSON.stringify(body))
    } catch (e) {
        // Reporting must never be the thing that breaks the plugin.
    }
}

// context is a short label saying where the throw was caught, so two different
// call sites failing the same way stay separate entries.
export function capture(error, context) {
    if (!enabled() || sent >= MAX_EVENTS) return
    var err = error || {}
    var type = err.name || 'Error'
    var value = String(err.message || err || 'unknown')
    var key = type + '|' + value + '|' + (context || '')
    if (seen[key]) return
    seen[key] = true
    sent++

    post({
        event_id: eventId(),
        timestamp: new Date().toISOString(),
        platform: 'javascript',
        level: 'error',
        logger: 'scrob-lampa-plugin',
        release: BUILD,
        exception: { values: [{ type: type, value: value }] },
        tags: {
            context: context || 'unknown',
            // Which Lampa build a report came from decides whether it is our bug.
            lampa: safe(function () { return String(Lampa.Manifest.app_digital) }) || 'unknown',
            device: safe(function () { return String(Lampa.Platform.get()) }) || 'unknown'
        },
        extra: {
            stack: String(err.stack || ''),
            user_agent: safe(function () { return navigator.userAgent }),
            // Scheme only - a self-hosted server address is the user's business.
            server_scheme: safe(function () {
                return String(Lampa.Storage.get(KEYS.SERVER_URL) || '').split(':')[0] || null
            })
        }
    })
}

export function init() {
    if (installed) return
    installed = true

    var previousOnError = window.onerror
    window.onerror = function (message, source, line) {
        capture({ name: 'Error', message: message }, 'onerror ' + source + ':' + line)
        if (typeof previousOnError === 'function') return previousOnError.apply(this, arguments)
        return false
    }

    if (typeof window.addEventListener === 'function') {
        window.addEventListener('unhandledrejection', function (e) {
            capture((e && e.reason) || { message: 'unhandled rejection' }, 'unhandledrejection')
        })
    }

    // The plugin swallows most of its own failures into console.error('Scrob', …)
    // and those never reach window.onerror - during a beta they are exactly the
    // ones worth seeing. Filter on the tag so Lampa's own noise stays out.
    var previousConsoleError = console.error
    console.error = function () {
        try {
            if (arguments[0] === 'Scrob' || arguments[0] === 'ScrobSocket') {
                var args = Array.prototype.slice.call(arguments)
                var last = args[args.length - 1]
                capture(
                    (last && last.message) ? last : { name: 'ScrobLog', message: args.join(' ') },
                    args.slice(0, -1).join(' ')
                )
            }
        } catch (e) {
            // never let reporting break logging
        }
        if (typeof previousConsoleError === 'function') previousConsoleError.apply(console, arguments)
    }
}
