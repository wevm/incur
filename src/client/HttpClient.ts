import * as Client from './Client.js'
import * as HttpTransport from './transports/HttpTransport.js'
import type { ClientDefaults, Commands, HttpClient } from './types.js'

export type { HttpClient }

/** Creates an HTTP typed client. */
export function create<const commands = Commands, const defaults extends ClientDefaults = {}>(
  options: HttpTransport.Options & defaults & ClientDefaults,
): HttpClient<commands, defaults> {
  const { baseUrl, fetch, headers, ...defaults } = options
  return Client.create<commands, HttpTransport.HttpTransport, defaults>({
    ...defaults,
    transport: HttpTransport.create({
      baseUrl,
      ...(fetch ? { fetch } : undefined),
      ...(headers ? { headers } : undefined),
    }),
  } as HttpTransport.Options & defaults & { transport: HttpTransport.HttpTransport })
}
