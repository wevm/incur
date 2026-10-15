import { describe, expect, test } from 'vitest'

import { isPlainObject, levenshtein, suggest } from './helpers.js'

describe('isPlainObject', () => {
  test.each([
    { name: 'object literal', value: { a: 1 }, expected: true },
    { name: 'null prototype', value: Object.create(null), expected: true },
    { name: 'array', value: [1, 2], expected: false },
    { name: 'date', value: new Date(0), expected: false },
    { name: 'map', value: new Map(), expected: false },
    { name: 'class instance', value: new (class {})(), expected: false },
    { name: 'null', value: null, expected: false },
    { name: 'number', value: 42, expected: false },
    { name: 'string', value: 'a', expected: false },
  ])('$name', ({ value, expected }) => {
    expect(isPlainObject(value)).toBe(expected)
  })
})

describe('levenshtein', () => {
  test('identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0)
  })

  test('single insertion', () => {
    expect(levenshtein('abc', 'abcd')).toBe(1)
  })

  test('single deletion', () => {
    expect(levenshtein('abcd', 'abc')).toBe(1)
  })

  test('single substitution', () => {
    expect(levenshtein('abc', 'axc')).toBe(1)
  })

  test('transposition counts as 2', () => {
    expect(levenshtein('mpc', 'mcp')).toBe(2)
  })

  test('empty strings', () => {
    expect(levenshtein('', '')).toBe(0)
    expect(levenshtein('abc', '')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
  })
})

describe('suggest', () => {
  const commands = ['deploy', 'status', 'list', 'create']

  test('returns closest match within threshold', () => {
    expect(suggest('deplyo', commands)).toBe('deploy')
  })

  test('returns match for transposition', () => {
    expect(suggest('mpc', ['mcp', 'skills', 'completions'])).toBe('mcp')
  })

  test('returns undefined when no match is close enough', () => {
    expect(suggest('xyz', commands)).toBeUndefined()
  })

  test('returns undefined for empty candidates', () => {
    expect(suggest('deploy', [])).toBeUndefined()
  })

  test('picks the closest among multiple candidates', () => {
    expect(suggest('craete', ['list', 'create', 'delete'])).toBe('create')
  })

  test('matches unambiguous prefix', () => {
    expect(suggest('ski', ['mcp', 'skills', 'completions'])).toBe('skills')
  })

  test('prefers shorter prefix match among ambiguous prefixes', () => {
    expect(suggest('ski', ['skills', 'skip'])).toBe('skip')
  })

  test('prefix match beats fuzzy match', () => {
    expect(suggest('iss', ['issue', 'is', 'miss'])).toBe('issue')
  })

  test('contains match beats fuzzy match', () => {
    expect(suggest('sue', ['issue', 'use', 'sum'])).toBe('issue')
  })

  test('case-insensitive matching', () => {
    expect(suggest('Deploy', ['deploy', 'list'])).toBe('deploy')
  })
})
