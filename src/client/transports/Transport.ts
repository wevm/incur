/** Transport type names. */
export type TransportType = 'http' | 'memory'

/** Transport configuration. */
export type Config<type extends TransportType> = {
  /** Stable transport key. */
  key: string
  /** Human-readable transport name. */
  name: string
  /** Transport type. */
  type: type
}

/** Transport capabilities exposed by a resolved transport. */
export type Capabilities = Record<string, unknown>

/** Transport factory. */
export type Factory<type extends TransportType, capabilities extends Capabilities> = () => {
  config: Config<type>
} & capabilities
