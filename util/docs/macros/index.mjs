/*
 * Copyright 2021 Comcast Cable Communications Management, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import crocksHelpers from 'crocks/helpers/index.js'
const { getPathOr, compose, tap } = crocksHelpers

import { getLinkFromRef } from '../../shared/helpers.mjs'
import { getMethodSignature, getMethodSignatureParams ,getSchemaType, getSchemaShape } from '../../shared/typescript.mjs'
import { getPath, getExternalPath, getExternalSchemaPaths, getSchemaConstraints, isDefinitionReferencedBySchema, localizeDependencies } from '../../shared/json-schema.mjs'
import fs from 'fs'
import pointfree from 'crocks/pointfree/index.js'
const { filter, option, map } = pointfree
import isArray from 'crocks/predicates/isArray.js'
import safe from 'crocks/Maybe/safe.js'

var pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));


const PROVIDER_PREF = "onRequest"
const PROVIDER_PREF_LEN = PROVIDER_PREF.length

/**
 * TODO
 * - add See also, or enum input for schemas (e.g. ProgramType used by Discovery)
 */

// util for visually debugging crocks ADTs
const _inspector = obj => {
  if (obj.inspect) {
    console.log(obj.inspect())
  } else {
    console.log(obj)
  }
}

const insertAggregateMacrosOnly = () => false

const getTitle = json => json.info ? json.info.title : json.title

const hasEventAttribute = (method, attribute) => method.tags && method.tags.find(t => t.name === 'event').hasOwnProperty(attribute)
const hasNonEmptyEventAttribute = (method, attribute) => {
    if (!method.tags) return false
    const tag = method.tags.find(t => t.name === 'event')
    return tag[attribute] && tag[attribute].length
} 
const isEvent = method => hasTag(method, 'event')
const isProviderMethod = method => isEvent(method) && hasNonEmptyEventAttribute(method, 'x-provides')
const isFullyDocumentedEvent = method => isEvent(method) && !hasTag('rpc-only') && !hasEventAttribute(method, 'x-alternative') && !hasEventAttribute(method, 'x-pulls-for')
const isSetter = method => method.tags && method.tags.find(t => t['x-setter-for'])

const providerMethodName = m => m.name.startsWith(PROVIDER_PREF) 
    ? m.name[PROVIDER_PREF_LEN].toLowerCase() + m.name.substr(PROVIDER_PREF_LEN + 1)
    : ''

function hasTag (method, tag) {
    return method.tags && method.tags.filter(t => (t.name === tag)).length > 0
}

export {
    insertAggregateMacrosOnly,
    insertMacros,
}

function insertMacros(data = '', moduleJson = {}, templates = {}, schemas = {}, options = {}, version = {}) {
    let match, regex
    const methods = moduleJson.methods && moduleJson.methods.filter( method => !isEvent(method) && !isSetter(method) || (isEvent(method) && isFullyDocumentedEvent(method)) || isProviderMethod(method))
    const additionalEvents = moduleJson.methods && moduleJson.methods.filter( method => isEvent(method) && !isFullyDocumentedEvent(method) && !isProviderMethod(method))
    
    const hasEvents = (additionalEvents && additionalEvents.length > 0) || (methods && methods.find(method => isEvent(method) && !isProviderMethod(method)))
    const providerMethods = moduleJson.methods && moduleJson.methods.filter( method => isProviderMethod(method))
    const hasProviderMethods = (providerMethods && providerMethods.length > 0)

    if (methods) {
        methods.sort( (a, b) => (a.name.toLowerCase() > b.name.toLowerCase()) ? 1 : -1 )
        regex = /\$\{events\}/
        if (match = data.match(regex)) {
            let events = ''
            methods.forEach(method => {
                if (isEvent(method) && !isProviderMethod(method)) {
                    events += insertMethodMacros(match[0], method, moduleJson, schemas, templates, options)
                }
            })
            data = data.replace(regex, events)
        }
        regex = /\$\{providers\}/
        if (match = data.match(regex)) {
            let providers = ''
            methods.forEach(method => {
                if (isProviderMethod(method)) {
                    providers += insertMethodMacros(match[0], method, moduleJson, schemas, templates, options)
                }
            })
            data = data.replace(regex, providers)
        }

        if (hasEvents) {

            const listenerTemplate = 
            {
                name: 'listen',
                tags: [
                    {
                        name: 'listener'
                    }
                ],
                summary: 'Listen for events from this module.',
                params: [
                    {
                        name: 'event',

                        schema: {
                            type: 'string'
                        }
                    }
                ],
                result: {
                    name: 'success',
                    schema: {
                        type: 'boolean'
                    }
                }
            }

            methods.push(listenerTemplate)
            methods.push(Object.assign({}, listenerTemplate, { name: "once", summary: "Listen for only one occurance of an event from this module. The callback will be cleared after one event." }))
            methods.sort( (a, b) => (a.name.toLowerCase() > b.name.toLowerCase()) ? 1 : -1 )
        }
        else {
            data = data.replace(/\$\{if\.events\}.*?\{end\.if\.events\}/gms, '')
        }

        if (hasProviderMethods) {

            const providerTemplate = 
            {
                name: 'provide',
                tags: [
                ],
                summary: 'Register a provider from this module',
                params: [
                    {
                        name: 'provider',
                        required: true,
                        schema: {
                            type: 'object'
                        }
                    }
                ],
                result: {
                    name: 'success',
                    schema: {
                        const: 'null'
                    }
                }
            }
            methods.push(providerTemplate)
        } else {
            data = data.replace(/\$\{if\.providers\}.*?\{end\.if\.providers\}/gms, '')
        }

        regex = /\$\{methods\}/
        while (match = data.match(regex)) {
            let methodsStr = ''
            methods.forEach(method => {
                if (!method.tags || (!method.tags.find(t => t.name === 'event'))) {
                    methodsStr += insertMethodMacros(match[0], method, moduleJson, schemas, templates, options)
                }
            })
            data = data.replace(regex, methodsStr)
        }

        regex = /[\# \t]*?\$\{event\.[a-zA-Z]+\}.*?\$\{end.event\}/s
        while (match = data.match(regex)) {
            data = data.replace(regex, insertEventMacros(match[0], methods, moduleJson, schemas, templates, options))
        }

        let js = false //!!
        methods.forEach(m => {
            if (!m.tags || !m.tags.map(t => t.name).includes('rpc-only')) {
                js = true
            }
        })

        // get rid of javascript-specific template contents if there is no javascript method in this module
        if (!js) {
            data = data.replace(/\$\{if\.javascript\}.*?\{end\.if\.javascript\}/gms, '')
        }

    }

    if (additionalEvents && additionalEvents.length > 0) {
        regex = /\$\{additionalEvents\}/
        while (match = data.match(regex)) {
            let additionalStr = ''
            additionalEvents.forEach(event => {
                // copy it
                event = JSON.parse(JSON.stringify(event))
                // change the template
                event.tags.find(t => t.name === 'event').name = 'additional-event'
                // drop the ListenerResponse result type
                event.result.schema = (event.result.schema.oneOf || event.result.schema.anyOf)[1]
                additionalStr += insertMethodMacros(match[0], event, moduleJson, schemas, templates, options)
            })
            data = data.replace(regex, additionalStr)
        }
    }

    let local_schemas, prefix

    if (moduleJson.components && moduleJson.components.schemas && Object.values(moduleJson.components.schemas).length) {
        local_schemas = moduleJson.components.schemas
        prefix = '#/components/schemas/'
    }
    else if (moduleJson.definitions && Object.values(moduleJson.definitions).length) {
        local_schemas = moduleJson.definitions
        prefix = '#/definitions/'
    }

    if (local_schemas) {
        regex = /[\# \t]*?\$\{schema\.[a-zA-Z]+\}.*?\$\{end.schema\}/s
        while (match = data.match(regex)) {
            data = data.replace(regex, insertSchemaMacros(match[0], local_schemas, moduleJson, schemas, options))
        }
        let schemas_toc = []
        Object.entries(local_schemas).forEach(([n, v]) => {
            if (true || isDefinitionReferencedBySchema(prefix + n, moduleJson)) {
                let str = v.title ? v.title : n
                str = '    - [' + str + '](#' + str.toLowerCase() + ')'
                schemas_toc.push(str)
            }
        })

        schemas_toc = schemas_toc.join('\n')

        data = data.replace(/\$\{toc.schemas\}/g, schemas_toc)

    }
    else {
        data = data.replace(/\$\{if\.schemas\}.*?\{end\.if\.schemas\}/gms, '')
    }

    if (methods) {
        data = data
            .replace(/\$\{toc.methods\}/g, methods.filter(m => !m.name.match(/^on[A-Z]/)).map(m => '    - [' + m.name + '](#' + m.name.toLowerCase() + ')').join('\n'))
            .replace(/\$\{toc.events\}/g, methods.filter(m => isEvent(m) && !isProviderMethod(m)).map(m => '    - [' + m.name[2].toLowerCase() + m.name.substr(3) + '](#' + m.name.substr(2).toLowerCase() + ')').join('\n'))
            .replace(/\$\{toc.providers\}/g, methods.filter(m => isProviderMethod(m)).map(m => '    - [' + providerMethodName(m) + '](#' + providerMethodName(m).toLowerCase() + ')').join('\n'))
    }

    data = data
        .replace(/\$\{module}/g, getTitle(moduleJson).toLowerCase() + '.json')
        .replace(/\$\{info.title}/g, getTitle(moduleJson))
        .replace(/\$\{package.name}/g, pkg.name)
        .replace(/\$\{package.repository}/g, pkg.repository && pkg.repository.url && pkg.repository.url.split("git+").pop().split("/blob").shift() || '')
        .replace(/\$\{package.repository.name}/g, pkg.repository && pkg.repository.url && pkg.repository.url.split("/").slice(3,5).join("/") || '')
        .replace(/\$\{info.version}/g, version.readable)
        .replace(/\$\{info.description}/g, moduleJson.info && moduleJson.info.description || '')

    data = data.replace(/\$\{[a-zA-Z.]+\}\s*\n?/g, '') // remove left-over macros

    return data
}

function insertMethodMacros(data, method, moduleJson = {}, schemas = {}, templates = {}, options = {}) {
    let result = ''

    if (!data) return ''

    let template = method.tags && method.tags.map(t=>t.name).find(t => Object.keys(templates).includes('methods/' + t + '.md')) || 'default'
    if (hasTag(method, 'property') || hasTag(method, 'property:readonly') || hasTag(method, 'property:immutable')) {
        template = 'polymorphic-property'
    }
    if (isProviderMethod(method)) {
        template = 'provider'
    }
    data = templates[`methods/${template}.md`]
    data = iterateSignatures(data, method, moduleJson, schemas, templates, options)

    if (method.params.length === 0) {
        data = data.replace(/\$\{if\.params\}.*?\{end\.if\.params\}/gms, '')
    }
    if (!method.examples || method.examples.length === 0) {
        data = data.replace(/\$\{if\.examples\}.*?\{end\.if\.examples\}/gms, '')
    }
    if (!method.description) {
        data = data.replace(/\$\{if\.description\}.*?\{end\.if\.description\}/gms, '')
    }

    let method_data = data
    const alternative = method.tags && method.tags.find( t => t['x-alternative']) || { 'x-alternative': ''}
    const pullsFor = method.tags && method.tags.find( t => t['x-pulls-for']) || { 'x-pulls-for': ''}
    const seeAlso = alternative['x-alternative'] || pullsFor['x-pulls-for']
    const seeAlsoLink = `[${seeAlso}](#${seeAlso.toLowerCase()})`
    const eventJsName = method.name.length > 3 ? method.name[2].toLowerCase() + method.name.substr(3) : method.name

    const deprecated = method.tags && method.tags.find( t => t.name === 'deprecated')
    if (deprecated ) {
        let alternative = deprecated['x-alternative'] || ''
        let since = deprecated['x-since'] || ''

        if (alternative && alternative.indexOf(' ') === -1) {
          alternative = `Use \`${alternative}\` instead.`
        }
    
        method_data = method_data
            .replace(/\$\{method.description\}/g, `This API is **deprecated**` + (since ? ` since version ${since}. ` : '. ') + `${alternative}\n\n\$\{method.description\}`)
    }

    method_data = method_data
        .replace(/\$\{method.name\}/g, method.name)
        .replace(/\$\{event.name\}/g, method.name.length > 3 ? method.name[2].toLowerCase() + method.name.substr(3): method.name)
        .replace(/\$\{provider.name\}/g, providerMethodName(method))
        .replace(/\$\{event.javascript\}/g, method.tags && method.tags.find(t => t.name === 'rpc-only') ? '_NA_' : eventJsName)
        .replace(/\$\{event.rpc\}/g, method.name)
        .replace(/\$\{method.summary\}/g, method.summary)
        .replace(/\$\{method.description\}/g, method.description || method.summary)
        .replace(/\$\{module\}/g, getTitle(moduleJson))
        .replace(/\$\{event.seeAlso\}/g, seeAlsoLink)

    method_data = method_data.replace(/\$\{.*?method.*?\}\s*\n?/g, '')

    result += method_data + '\n'

    return result
}

function generatePropertySignatures (m) {
    let signatures = [m]
    if (hasTag(m, 'property') && !hasTag(m, 'property:immutable') && !hasTag(m, 'property:readonly')) {
        signatures.push({
            name: m.name,
            summary: 'Set value for ' + m.summary,
            tags: [
                {
                    name: 'property-set'
                }
            ],
            // setter takes the getters result
            params: [
                {
                    ...m.result,
                    name: 'value',
                    required: true
                }
            ],
            result: {
                name: "response",
                summary: "",
                schema: {
                  const: null
                }
            },
            examples: [
                {
                    name: "",
                    params: [
                      {
                        name: "value",
                        value: m.examples[0].result.value
                      }
                    ],
                    result: {
                      name: "Default Result",
                      value: null
                    }
                  }
            ]
        })
    } else {
        signatures.push(null)
    }
    if ((hasTag(m, 'property') || hasTag(m, 'property:readonly')) && !hasTag(m, 'property:immutable')) {
        const examples = []
        m.examples.forEach(e => examples.push(JSON.parse(JSON.stringify(e))))
        examples.forEach(e => { e.params = [ { name: m.result.name, value: e.result.value } ]; e.result = { name: 'listenerId', value: 1 }; })

        signatures.push({
            name: m.name,
            summary: 'Subscribe to value for ' + m.summary,
            tags: [{
                name: 'property-subscribe'
            }],
            params: [
                {
                    ...m.result,
                    required: true
                }
            ],
            result: {
                name: "listenerId",
                summary: "",
                schema: {
                    type: "integer"
                }
            },
            examples: m.examples
        })
    } else {
        signatures.push(null)
    }
    return signatures
}

function iterateSignatures(data, method, moduleJson = {}, schemas = {}, templates = {}, options = {}) {
    // we're hacking the schema here... make a copy!
    method = JSON.parse(JSON.stringify(method))
    const module = moduleJson.info.title
    let signatures = [method]
    if (hasTag(method, 'property') || hasTag(method, 'property:readonly') || hasTag(method, 'property:immutable')) {
        signatures = generatePropertySignatures(method)
    }
    
    if (method.tags && method.tags.find(t => t.name === 'polymorphic-pull')) {
        // copy the method for the pull version
        const pull = JSON.parse(JSON.stringify(method))
        
        // change the original to be 'push'
        method.tags.find(t => t.name === 'polymorphic-pull').name = ''

        // change result of pull-method to be the params of the original push-method
        const resultRef = method.name[0].toUpperCase() + method.name.substr(1) + 'Result'
        pull.result = {
            "name": "results",
            "schema": {
                "$ref": `#/components/schemas/${resultRef}`
            }
        }

        // Find the parameters for the pull method
        const pullEventMethod = moduleJson.methods.find(m => m.name.toLowerCase() === 'onpull' + method.name.toLowerCase())
        const pullParameters = localizeDependencies(
          getPath(
            '#/components/schemas/' + method.name[0].toUpperCase() + method.name.substr(1) + 'Parameters',
            moduleJson,
            schemas
          ),
          moduleJson,
          schemas
        ) || getExternalPath('#/definitions/' + method.name[0].toUpperCase() + method.name.substr(1), schemas, true)
        
        if (pullParameters) {
            pull.params = [Object.assign({ schema: pullParameters }, { name: 'parameters', required: true, summary: pullEventMethod.result.summary })]
        }
        else {
            console.log('WARNING: could not find '+method.name[0].toUpperCase() + method.name.substr(1) + 'Parameters schema')
            process.exit(1)
        }

        if (pull.examples) {
            pull.examples.forEach(example => {
                example.name = example.name + ' (Pull)'
                example.result = {
                    "name": "result",
                    "value": {}
                }
                if (example.params) {
                    example.params.forEach(param => {
                        example.result.value[param.name] = param.value
                    })
                }
            })
        }
        signatures = [pull, ...signatures]
    }
    else if (method.tags && method.tags.find(t => t.name === 'event')) {
        const possibleResults = method.result.schema.oneOf || method.result.schema.anyOf
        if (possibleResults && possibleResults.length == 2) {
            method.result.schema = possibleResults.find(s => s['$ref'] !== "https://meta.comcast.com/firebolt/types#/definitions/ListenResponse")
        }
        else {
            console.log(`\nERROR: ${getTitle(moduleJson.info.title)}.${method.name} does not have two return types: both 'ListenResponse' and an event-specific payload\n`)
            process.exit(1)
        }
    }

    let regex, match

    signatures.forEach(sig => {
        regex = /\$\{method\.[0-9]\}(.*?)\$\{(end\.method|method\.[0-9])\}/s
        match = data.match(regex)

        if (!match) {
            regex = /(.*)/s
            match = data.match(regex)
        }

        let block = sig == null ? '' : insertSignatureMacros(match[1], sig, moduleJson, schemas, templates, options)
        data = data.replace(regex, block)
    })

    return data
}

function insertSignatureMacros(block, sig, moduleJson = {}, schemas = {}, templates = {}, options = {}) {
    if (sig.params.length === 0) {
        block = block.replace(/\$\{if\.params\}.*?\{end\.if\.params\}/gms, '')
    }
    if (!sig.examples || sig.examples.length === 0) {
        block = block.replace(/\$\{if\.examples\}.*?\{end\.if\.examples\}/gms, '')
    }

    if (sig.tags && sig.tags.map(t => t.name).includes('rpc-only')) {
        block = block.replace(/\$\{if\.javascript\}.*?\{end\.if\.javascript\}/gms, '')
    }

    let regex = /[\# \t]*?\$\{example\.[a-zA-Z]+\}.*?\$\{end.example\}/s
    let match = block.match(regex)
 
    if (match) {
        let exampleBlock = insertExampleMacros(match[0], sig, moduleJson, templates, options)
        block = block.replace(regex, exampleBlock)
    }

    let lines = block.split('\n')

    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].match(/\$\{method\.param\.[a-zA-Z]+\}/)) {
            let line = lines[i]
            lines.splice(i, 1)
            sig.params.forEach((param) => { lines.splice(i++, 0, insertParamMacros(line, param, moduleJson, schemas, options)) })
        }
    }

    block = lines.join('\n')

    block = block.replace(/\$\{method.signature\}/g, getMethodSignature(moduleJson, sig, schemas, { isInterface: false }))
        .replace(/\$\{method.params\}/g, getMethodSignatureParams(moduleJson, sig, schemas))
        .replace(/\$\{method.paramNames\}/g, sig.params.map(p => p.name).join(', '))
        .replace(/\$\{method.result.name\}/g, sig.result.name)
        .replace(/\$\{method.result.summary\}/g, sig.result.summary)
        .replace(/\$\{method.result.link\}/g, getSchemaType(moduleJson, sig.result, schemas, {title: true, link: true, asPath: options.asPath, baseUrl: options.baseUrl}))
        .replace(/\$\{method.result.type\}/g, getSchemaType(moduleJson, sig.result, schemas, {title: true, asPath: options.asPath, baseUrl: options.baseUrl}))
        .replace(/\$\{method.result\}/g, getSchemaTypeTable(moduleJson, sig.result, schemas, { description: sig.result.summary, title: true, asPath: options.asPath, baseUrl: options.baseUrl}))

    return block
}

function insertSchemaMacros(data, local_schemas = {}, moduleJson = {}, schemas = {}, options = {}) {
    let result = ''
    const prefix = moduleJson.info ? '#/components/schemas/' : '#/definitions/'

    Object.entries(local_schemas).forEach(([name, schema]) => {
        if (true || isDefinitionReferencedBySchema(prefix + name, (moduleJson.methods ? moduleJson.methods : moduleJson)) || schema.title) {
            let lines = data
            if (!schema.examples || schema.examples.length === 0) {
                lines = lines.replace(/\$\{if\.examples\}.*?\{end\.if\.examples\}/gms, '')
            }
            if (!schema.description) {
                lines = lines.replace(/\$\{if\.description\}.*?\{end\.if\.description\}/gms, '')
            }
            lines = lines.split('\n')
            const schemaShape = getSchemaShape(moduleJson, schema, schemas, name)

            let schema_data = lines.join('\n')
                .replace(/\$\{schema.title\}/, (schema.title || name))
                .replace(/\$\{schema.description\}/, schema.description)
                .replace(/\$\{schema.shape\}/, schemaShape)

            if (schema.examples) {
                schema_data = schema_data.replace(/\$\{schema.example\}/, schema.examples.map(ex => JSON.stringify(ex, null, '  ')).join('\n\n'))
            }

            let seeAlso = getExternalSchemaLinks(schema, schemas, options)
            if (seeAlso) {
                schema_data = schema_data.replace(/\$\{schema.seeAlso\}/, '\n\n' + seeAlso)
            }
            else {
                schema_data = schema_data.replace(/.*\$\{schema.seeAlso\}/, '')
            }

            schema_data = schema_data.replace(/\$\{.*?schema.*?\}\s*\n?/g, '')

            result += schema_data + '\n'
        }
    })

    return result
}

function insertEventMacros(data = '', methods = [], moduleJson = {}, schemas = {}, templates = {}, options = {}) {
    let result = ''

    methods.forEach(method => {
        if (!method.name.match(/^on[A-Za-z]+/)) {
            return
        }
        let lines = data
        if (method.params.length === 0) {
            lines = lines.replace(/\$\{if\.params\}.*?\{end\.if\.params\}/gms, '')
        }
        if (!method.examples || method.examples.length === 0) {
            lines = lines.replace(/\$\{if\.examples\}.*?\{end\.if\.examples\}/gms, '')
        }
        if (!method.description) {
            lines = lines.replace(/\$\{if\.description\}.*?\{end\.if\.description\}/gms, '')
        }
        lines = lines.split('\n')

        let method_data = lines.join('\n')
            .replace(/\$\{event.name\}/, method.name[2].toLowerCase() + method.name.substr(3))
            .replace(/\$\{event.summary\}/, method.summary)
            .replace(/\$\{event.description\}/, method.description)
            .replace(/\$\{event.result.name\}/, method.result.name)
            .replace(/\$\{event.result.summary\}/, method.result.summary)
            .replace(/\$\{event.result.type\}/, getSchemaTypeTable(moduleJson, method.result, schemas, { event: true, description: method.result.summary, asPath: options.asPath, baseUrl: options.baseUrl })) //getType(method.result, true))

        let match, regex = /[\# \t]*?\$\{example\.[a-zA-Z]+\}.*?\$\{end.example\}/s
        while (match = method_data.match(regex)) {
            method_data = method_data.replace(regex, insertExampleMacros(match[0], method, moduleJson, templates))
        }

        method_data = method_data.replace(/\$\{.*?method.*?\}\s*\n?/g, '')

        result += method_data + '\n'
    })

    return result
}

function insertParamMacros(data = '', param, module = {}, schemas = {}, options = {}) {
    let constraints = getSchemaConstraints(param, module, schemas)
    let type = getSchemaType(module, param, schemas, { code: true, link: true, title: true, asPath: options.asPath, baseUrl: options.baseUrl })

    if (constraints && type) {
        constraints = '<br/>' + constraints
    }

    return data
        .replace(/\$\{method.param.name\}/, param.name)
        .replace(/\$\{method.param.summary\}/, param.summary || '')
        .replace(/\$\{method.param.required\}/, param.required || 'false')
        .replace(/\$\{method.param.type\}/, type) //getType(param))
        .replace(/\$\{method.param.constraints\}/, constraints) //getType(param))
}

function insertExampleMacros(data, method, moduleJson = {}, templates = {}) {
    let result = ''
    let first = true


    const moduleName = getTitle(moduleJson)
    if (method.tags && method.tags.map(t => t.name).includes('rpc-only')) {
        data = data.replace(/\$\{if\.javascript\}.*?\{end\.if\.javascript\}/gms, '')
    }

    method.examples && method.examples.forEach(example => {
        
        let params = example.params.map(p => JSON.stringify(p.value, null, '  ')).join(',\n').split('\n').join('\n' + ' '.repeat(moduleName.length + method.name.length + 2))
        const responseMethod = moduleJson.methods.find(m => m.name === providerMethodName(method) + 'Response')
        const providerResponse = responseMethod && responseMethod.examples && responseMethod.examples.length ? responseMethod.examples[0] : ''
        const providerRespParam = providerResponse.params && providerResponse.params.length ? providerResponse.params[0] : null
        let example_data = data
            .replace(/\$\{example.title\}/g, example.name)
            .replace(/\$\{example.javascript\}/g, generateJavaScriptExample(example, method, moduleJson, templates))
            .replace(/\$\{example.result\}/g, generateJavaScriptExampleResult(example))
            .replace(/\$\{example.params\}/g, params)
            .replace(/\$\{example.providerMethod\}/g, providerMethodName(method))
            .replace(/\$\{example.providerResponse\}/g, JSON.stringify(providerRespParam ? providerRespParam.value.response : null))
            .replace(/\$\{example.jsonrpc\}/g, generateRPCExample(example, method, moduleJson))
            .replace(/\$\{example.response\}/g, generateRPCExampleResult(example))
            .replace(/\$\{callback.jsonrpc\}/g, generateRPCCallbackExample(example, method, moduleJson))
            .replace(/\$\{callback.response\}/g, generateRPCCallbackExampleResult())
        result += example_data

        if (first && method.examples.length > 1) {
            result += '<details>\n    <summary>More examples...</summary>\n'
        }

        first = false
    })

    if (method.examples && method.examples.length > 1) {
        result += "</details>\n"
    }

    result = result.replace(/\$\{.*?example.*?\}\s*\n?/g, '')

    return result
}

function getSchemaTypeTable(module, moduleJson = {}, schemas = {}, options = {}) {
    let type = getSchemaType(module, moduleJson, schemas, options)
    let summary = moduleJson.summary

    if (moduleJson.schema) {
        moduleJson = moduleJson.schema
    }

    if (type === 'object' && moduleJson.properties) {
        let type = ''

        if (summary) {
            type = summary + '\n\n'
        }

        type += '| Field | Type | Description |\n'
            + '| ----- | ---- | ----------- |\n'

        Object.entries(moduleJson.properties).forEach(([name, prop]) => {
            type += `| \`${name}\` | ${getSchemaType(module, prop, schemas, { link: true, code: true, event: options.event, asPath: options.asPath, baseUrl: options.baseUrl }).replace('|', '\\|')} | ${prop.description || ''} |\n`
        })

        return type
    }
    else {
        let type = '| Type | Description |\n'
            + '| ---- | ----------- |\n'

        const obj = moduleJson.oneOf ? moduleJson.oneOf[0] : moduleJson
        const path = obj['$ref']
        const ref = path ? getPath(path, module, schemas) : moduleJson
    
        type += `| ${getSchemaType(module, moduleJson, schemas, { code: true, link: true, event: options.event, title: true, asPath: options.asPath, baseUrl: options.baseUrl }).replace('|', '\\|')} | ${moduleJson.description || ref.description || summary || ''} |\n`

        return type

    }
}

function getExternalSchemaLinks(json = {}, schemas = {}, options = {}) {
    const seen = {}
    // Generate list of links to other Firebolt docs
    //  - get all $ref nodes that point to external files
    //  - dedupe them
    //  - convert them to the $ref value (which are paths to other schema files), instead of the path to the ref node itself
    //  - convert those into markdown links of the form [Schema](Schema#/link/to/element)
    let links = getExternalSchemaPaths(json)
        .map(path => getPathOr(null, path, json))
        .filter(path => seen.hasOwnProperty(path) ? false : (seen[path] = true))
        .map(path => options.baseUrl + getLinkFromRef(path, schemas, options.asPath))
        .map(path => ' - [' + path.split("/").pop() + '](' + (options.asPath ? path.split('#')[0].toLowerCase() + '#' + path.split('#')[1].split('/').pop().toLowerCase()  : path) + ')')
        .join('\n')

    return links
}

function generateJavaScriptExample(example, m, moduleJson = {}, templates = {}) {
    if (m.name.match(/^on[A-Z]/)) {
        if (isProviderMethod(m)) {
            return generateProviderExample(m, moduleJson, templates)
        } else {
            return generateEventExample(m, moduleJson)
        }
    }

    const formatParams = (params, delimit, pretty = false) => params.map(p => JSON.stringify((example.params.find(x => x.name === p.name) || { value: null }).value, null, pretty ? '  ' : null)).join(delimit)
    let indent = ' '.repeat(getTitle(moduleJson).length + m.name.length + 2)
    let params = formatParams(m.params, ', ')
    if (params.length + indent > 80) {
        params = formatParams(m.params, ',\n', true)
        params = params.split('\n')
        let first = params.shift()
        params = params.map(p => indent + p)
        params.unshift(first)
        params = params.join('\n')
    }

    let typescript

    const template = m.tags && m.tags.map(t=>t.name).find(t => Object.keys(templates).includes('examples/' + t + '.md')) || 'default'
    typescript = templates[`examples/${template}.md`]

    typescript = typescript.replace(/\$\{example.params\}/g, params)

    return typescript
}

function generateJavaScriptExampleResult(example) {
    let typescript = JSON.stringify(example.result.value, null, '  ')

    return typescript
}

function generateRPCExample(example, m, moduleJson = {}) {
    if (m.tags && m.tags.filter(t => (t.name === 'property-subscribe')).length) {
        return generatePropertyChangedRPCExample(example, m, moduleJson)
    }
    else if (m.tags && m.tags.filter(t => (t.name === 'property-set')).length) {
        return generatePropertySetRPCExample(example, m, moduleJson.info.title)
    }
    let request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": `${getTitle(moduleJson).toLowerCase()}.${m.name}`,
        "params": {},
    }

    m.params.forEach(p => {
        let example_p = example.params.find(x => x.name === p.name)
        if (example_p) {
            request.params[p.name] = example_p.value
        }
    })

    return JSON.stringify(request, null, '  ')
}

function generatePropertyChangedRPCExample(example, m, module) {
    let request = {
        jsonrpc: "2.0",
        id: 1,
        "method": `${getTitle(module).toLowerCase()}.on${m.name.substr(0, 1).toUpperCase()}${m.name.substr(1)}Changed`,
        "params": {
            listen: true
        },
    }

    return JSON.stringify(request, null, '  ')
}

function generatePropertySetRPCExample(example, m, module) {
    let request = {
        jsonrpc: "2.0",
        id: 1,
        "method": `${module.toLowerCase()}.set${m.name.substr(0, 1).toUpperCase()}${m.name.substr(1)}`,
        "params": {
            value: example.params[0].value
        },
    }

    return JSON.stringify(request, null, '  ')
}

function generateRPCExampleResult(example) {
    return JSON.stringify({
        "jsonrpc": "2.0",
        "id": 1,
        "result": example.result.value
    }, null, '  ')
}

function generateRPCCallbackExample(example, m, moduleJson = {}) {
    let request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": `${getTitle(moduleJson).toLowerCase()}.${m.name}`,
        "params": {
            "correlationId": "xyz",
            "result": {}
        }
    }

    if (example.result.value && example.result.value.data) {
        Object.keys(example.result.value.data).forEach(key => {
            request.params.result[key] = example.result.value.data[key]
        })
    }

    return JSON.stringify(request, null, '  ')
}

function generateRPCCallbackExampleResult() {
  return JSON.stringify({
    "jsonrpc": "2.0",
    "id": 1,
    "result": true
  }, null, '  ')
}

function generateEventExample(m, moduleJson = {}) {
    const module = getTitle(moduleJson)
    let typescript = `import { ${module} } from '@firebolt-js/sdk'\n\n`
    typescript += `${module}.listen('${m.name[2].toLowerCase() + m.name.substr(3)}', ${m.result.name} => {\n`
    typescript += `  console.log(${m.result.name})\n`
    typescript += '})'
    return typescript
}

function generateProviderExample(m, moduleJson = {}, templates) {
    return templates[`examples/provider.md`]
}