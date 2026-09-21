import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import babel from '@rollup/plugin-babel'
import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import { compileString } from 'sass'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isProduction = process.env.NODE_ENV === 'production'

// Build id, overridable with SCROB_VERSION. Reaches the bundle through
// output.intro below and is read via src/build.js - used as the Lampa
// manifest version and as the Sentry release.
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
const version = process.env.SCROB_VERSION || `2.0.0_beta_${stamp}`

const banner = `/**
 * Scrob — Lampa plugin for self-hosted media tracking
 * Build: ${version}
 * Source: https://github.com/ellite/scrob
 */`

/**
 * Custom rollup plugin: inline file content via @@include("path") directive.
 * Supports both .css and .scss — compiles SCSS on the fly.
 */
function includeFile() {
    return {
        name: 'rollup-plugin-include-file',
        transform(code, id) {
            const dir = dirname(id)
            const regex = /@@include\("([^"]+)"\)/g
            let match
            let result = code
            let changed = false

            while ((match = regex.exec(code)) !== null) {
                const filePath = resolve(dir, match[1])
                try {
                    let content = readFileSync(filePath, 'utf-8')

                    // Compile SCSS to CSS if needed
                    if (filePath.endsWith('.scss') || filePath.endsWith('.sass')) {
                        const compiled = compileString(content, {
                            style: isProduction ? 'compressed' : 'expanded'
                        })
                        content = compiled.css
                    }

                    // Escape for embedding in JS string
                    const escaped = content
                        .trim()
                        .replace(/\\/g, '\\\\')
                        .replace(/'/g, "\\'")
                        .replace(/\n/g, '\\n')
                        .replace(/\r/g, '\\r')

                    result = result.replace(match[0], escaped)
                    changed = true
                } catch (e) {
                    this.warn(`@@include: could not read ${filePath}: ${e.message}`)
                }
            }

            return changed ? { code: result, map: null } : null
        }
    }
}

export default {
    input: 'src/main.js',
    output: {
        file: '../frontend/src/plugins/scrob.js',
        format: 'iife',
        banner,
        intro: `var SCROB_BUILD = ${JSON.stringify(version)};`,
        sourcemap: false
    },
    plugins: [
        includeFile(),
        nodeResolve(),
        commonjs(),
        babel({
            babelHelpers: 'bundled',
            presets: [
                ['@babel/preset-env', {
                    targets: { chrome: '37' }  // Android 5 Lollipop WebView
                }]
            ]
        })
    ]
}
