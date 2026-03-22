import { describe, expect, test } from 'vitest'
import { levenshtein, suggest } from './helpers.js'

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
})
