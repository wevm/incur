import { describe, expect, test } from 'vitest'

import packageJson from '../../package.json' with { type: 'json' }

describe('client package exports', () => {
  test('package exposes client subpath and keeps root separate', () => {
    expect(packageJson.exports['./client']).toMatchObject({
      types: './dist/client/index.d.ts',
      src: './src/client/index.ts',
      default: './dist/client/index.js',
    })
    expect(packageJson.exports['.']).toMatchObject({
      types: './dist/index.d.ts',
      src: './src/index.ts',
      default: './dist/index.js',
    })
  })
})
