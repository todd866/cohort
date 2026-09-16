/** Only canonical, same-origin image namespaces may use durable device storage. */
export function isOfflineImageKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('/open-media/')
    && !/[\\%?#\u0000-\u001f]/.test(value)
    && value.slice(1).split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}
