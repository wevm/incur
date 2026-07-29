import { Cli, z } from 'incur'

/**
 * You.com Search CLI - Web search for agents and humans
 * 
 * This CLI demonstrates adding You.com web search capabilities to incur.
 * It supports both keyless operation (100 free searches/day) and authenticated
 * operation with a YDC_API_KEY environment variable.
 */

const cli = Cli.create('search', {
  version: '1.0.0',
  description: 'Web search powered by You.com',
  sync: {
    suggestions: [
      'search for "TypeScript CLI frameworks"',
      'search for "latest Node.js features" and format as JSON',
      'search for AI agent tools with 5 results'
    ],
  },
})

cli.command('web', {
  description: 'Search the web using You.com',
  args: z.object({
    query: z.string().describe('Search query'),
  }),
  options: z.object({
    count: z.coerce.number().default(10).describe('Number of results to return (1-20)'),
    safesearch: z.enum(['strict', 'moderate', 'off']).default('moderate').describe('Safe search level'),
    freshness: z.enum(['day', 'week', 'month', 'year']).optional().describe('Freshness filter'),
    country: z.string().optional().describe('Country code for localized results (e.g., US, GB, CA)'),
  }),
  env: z.object({
    YDC_API_KEY: z.string().optional().describe('You.com API key for enhanced quotas'),
  }),
  output: z.object({
    query: z.string().describe('The search query that was executed'),
    results: z.array(z.object({
      title: z.string().describe('Page title'),
      url: z.string().describe('Page URL'),
      snippet: z.string().describe('Page description/snippet'),
      age: z.string().optional().describe('Age of the content'),
    })).describe('Search results'),
    total_results: z.number().optional().describe('Total number of available results'),
    api_used: z.enum(['keyless', 'authenticated']).describe('Which API endpoint was used'),
  }),
  examples: [
    { 
      args: { query: 'TypeScript CLI frameworks' }, 
      description: 'Basic web search' 
    },
    {
      args: { query: 'Node.js security best practices' },
      options: { count: 5, freshness: 'week' },
      description: 'Recent security articles',
    },
    {
      args: { query: 'machine learning tutorials' },
      options: { country: 'US', safesearch: 'moderate' },
      description: 'Localized safe search',
    },
  ],
  async run(c) {
    const { query } = c.args
    const { count, safesearch, freshness, country } = c.options
    const { YDC_API_KEY } = c.env

    // Determine which API endpoint to use
    const isAuthenticated = !!YDC_API_KEY
    const baseUrl = isAuthenticated 
      ? 'https://ydc-index.io/v1/search'
      : 'https://api.you.com/v1/agents/search'

    // Build search parameters
    const params = new URLSearchParams({
      query,
      count: count.toString(),
      safesearch,
    })

    if (freshness) params.append('freshness', freshness)
    if (country) params.append('country', country)

    // Build headers
    const headers: Record<string, string> = {
      'User-Agent': 'youdotcom-integration/wevm-incur',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    }

    if (isAuthenticated) {
      headers['X-API-Key'] = YDC_API_KEY
    }

    try {
      const response = await fetch(`${baseUrl}?${params}`, {
        method: 'GET',
        headers,
      })

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('Rate limit exceeded. Consider using a YDC_API_KEY for higher quotas.')
        }
        if (response.status === 401) {
          throw new Error('Invalid API key. Check your YDC_API_KEY environment variable.')
        }
        throw new Error(`Search failed: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      
      // Handle different response formats between keyless and authenticated APIs
      let results: Array<{ title: string; url: string; snippet: string; age?: string }> = []
      let totalResults: number | undefined

      if (data.results?.web) {
        // Authenticated API format
        results = data.results.web.map((item: any) => ({
          title: item.title || item.name || 'Untitled',
          url: item.url,
          snippet: item.snippet || item.description || '',
          age: item.age,
        }))
        totalResults = data.results.total_results
      } else if (Array.isArray(data.results)) {
        // Keyless API format
        results = data.results.map((item: any) => ({
          title: item.title || 'Untitled',
          url: item.url,
          snippet: item.snippet || item.description || '',
          age: item.age,
        }))
      } else {
        throw new Error('Unexpected response format from You.com API')
      }

      return {
        query,
        results,
        total_results: totalResults,
        api_used: isAuthenticated ? 'authenticated' : 'keyless',
      }
    } catch (error) {
      throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
})

// Add alias for backwards compatibility
cli.command('search', {
  description: 'Alias for "web" command',
  args: z.object({
    query: z.string().describe('Search query'),
  }),
  options: z.object({
    count: z.coerce.number().default(10).describe('Number of results to return (1-20)'),
    safesearch: z.enum(['strict', 'moderate', 'off']).default('moderate').describe('Safe search level'),
    freshness: z.enum(['day', 'week', 'month', 'year']).optional().describe('Freshness filter'),
    country: z.string().optional().describe('Country code for localized results (e.g., US, GB, CA)'),
  }),
  env: z.object({
    YDC_API_KEY: z.string().optional().describe('You.com API key for enhanced quotas'),
  }),
  // Forward to the web command - just run the same implementation
  async run(c) {
    // Just delegate to the web command implementation
    return cli._commands.get('web')?.run(c) as any
  }
})

cli.serve()

export default cli