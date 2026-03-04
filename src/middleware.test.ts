import middleware from './middleware.js'

test('returns the handler unchanged', () => {
  const handler = vi.fn()
  expect(middleware(handler)).toBe(handler)
})
