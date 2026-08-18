import { describe, it, expect } from 'vitest'
import { canonicalizeJson } from '../canonical-json'

describe('canonicalizeJson', () => {
  it('sorts top-level keys alphabetically', () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('sorts nested object keys recursively', () => {
    expect(canonicalizeJson({ b: { d: 1, c: 2 }, a: 1 })).toBe('{"a":1,"b":{"c":2,"d":1}}')
  })

  it('sorts object keys inside array elements but preserves array element order', () => {
    expect(canonicalizeJson({ a: [{ y: 1, x: 2 }, { z: 3 }] })).toBe('{"a":[{"x":2,"y":1},{"z":3}]}')
  })

  it('does not escape forward slashes (matches PHP JSON_UNESCAPED_SLASHES)', () => {
    expect(canonicalizeJson({ a: 'x/y' })).toBe('{"a":"x/y"}')
  })

  it('does not escape unicode characters (matches PHP JSON_UNESCAPED_UNICODE)', () => {
    expect(canonicalizeJson({ a: 'café' })).toBe('{"a":"café"}')
  })

  it('omits keys whose value is undefined, matching JSON.stringify object behavior', () => {
    expect(canonicalizeJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('round-trips primitives the same as JSON.stringify', () => {
    expect(canonicalizeJson('hello')).toBe('"hello"')
    expect(canonicalizeJson(42)).toBe('42')
    expect(canonicalizeJson(true)).toBe('true')
    expect(canonicalizeJson(null)).toBe('null')
  })
})
