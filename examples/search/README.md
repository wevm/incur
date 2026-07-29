# You.com Search CLI Example

This example demonstrates how to integrate You.com web search capabilities into an incur CLI.

## Features

- 🔍 **Web Search**: Search the web using You.com's Search API
- 🔑 **Dual Operation Modes**: 
  - **Keyless**: 100 free searches/day (no setup required)
  - **Authenticated**: Higher quotas with `YDC_API_KEY`
- 🎛️ **Flexible Options**: Control result count, safe search, freshness, and localization
- 🤖 **Agent-Friendly**: Works with Claude Desktop, MCP clients, and agent skills
- 📊 **Multiple Formats**: TOON (default), JSON, YAML, and Markdown output

## Quick Start

### Keyless (No Setup Required)

```bash
# Basic search
npm run search web "TypeScript CLI frameworks"

# Limit results
npm run search web "Node.js tutorials" --count 5

# Filter by freshness
npm run search web "AI news" --freshness week
```

### With API Key (Higher Quotas)

```bash
# Set your You.com API key
export YDC_API_KEY=your_api_key_here

# Now you get enhanced quotas and features
npm run search web "machine learning" --count 20
```

## Output Formats

### Default (TOON - Token Efficient)
```bash
npm run search web "incur CLI framework"
```

### JSON
```bash
npm run search web "incur CLI framework" --format json
```

### Markdown (Great for Documentation)
```bash
npm run search web "incur CLI framework" --format md
```

## Agent Integration

### MCP (Model Context Protocol)

```bash
# Register as MCP server
npm run search mcp add

# Then use in Claude Desktop or other MCP clients
```

### Agent Skills

```bash
# Generate skill files for agents
npm run search skills add
```

### Direct Agent Usage

Agents can discover and use this CLI automatically:

```
Run `npx incur-youcom-search-example skills add`, then search for "TypeScript best practices".
```

## Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `query` | string | *(required)* | Search query |
| `--count` | number | 10 | Number of results (1-20) |
| `--safesearch` | enum | moderate | Safe search level: strict, moderate, off |
| `--freshness` | enum | *(optional)* | Filter by age: day, week, month, year |
| `--country` | string | *(optional)* | Country code for localized results (US, GB, CA, etc.) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `YDC_API_KEY` | Optional You.com API key for enhanced quotas |

## Error Handling

- **Rate Limits**: Suggests upgrading to API key when rate limited
- **Invalid Keys**: Clear error message for authentication issues  
- **Network Errors**: Graceful handling with informative messages
- **Malformed Responses**: Validates API response structure

## Integration Patterns

This example shows several integration patterns:

1. **Dual API Support**: Seamlessly switches between keyless and authenticated endpoints
2. **Agent Discovery**: Built-in MCP and skill file generation
3. **Flexible Output**: Multiple format options for different use cases
4. **Error Resilience**: Comprehensive error handling and user guidance
5. **Type Safety**: Full TypeScript types for arguments, options, and responses

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev web "test search"

# Build for production
npm run build
```