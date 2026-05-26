/** Transport context supplied when resolving a transport factory. */
export type TransportContext = {
  /** Client uid. */
  uid: string
}

/** Transport type names. */
export type TransportType = 'http' | 'memory'

/** Transport configuration. */
export type TransportConfig<type extends TransportType> = {
  /** Stable transport key. */
  key: string
  /** Human-readable transport name. */
  name: string
  /** Transport type. */
  type: type
}

/** Transport capabilities exposed by a resolved transport. */
export type TransportCapabilities = Record<string, unknown>

/** Transport factory. */
export type TransportFactory<
  type extends TransportType,
  capabilities extends TransportCapabilities,
> = (context: TransportContext) => { config: TransportConfig<type> } & capabilities
