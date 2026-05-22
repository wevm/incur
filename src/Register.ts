/**
 * Type-safe registration interface. Populate via declaration merging or codegen to enable CTA autocomplete.
 *
 * @example
 * ```ts
 * // codegen: run `mycli --codegen` to generate this file
 * declare module 'incur' {
 *   interface Register {
 *     commands: {
 *       get: { args: { id: number }; options: {}; output: { name: string } }
 *       list: { args: {}; options: { limit: number } }
 *     }
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: populated via declaration merging
export interface Register {}
