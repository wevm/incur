import * as Client from './Client.js'
import * as HttpTransport from './transports/HttpTransport.js'

/** HTTP client instance. */
export type HttpClient<
  commands = Client.Commands,
  defaults extends Client.Defaults = {},
> = Client.Client<commands, HttpTransport.HttpTransport, defaults>

/** Creates an HTTP typed client. */
export function create<
  const commands = Client.Commands,
  const defaults extends Client.Defaults = {},
>(options: HttpTransport.Options & defaults & Client.Defaults): HttpClient<commands, defaults> {
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
