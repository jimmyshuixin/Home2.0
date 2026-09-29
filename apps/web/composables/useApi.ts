import { createApiClient } from '~/lib/api-request'
export { ApiError, type ApiResult } from '~/lib/api-request'

export function useApi() {
  return createApiClient(useRuntimeConfig().public.apiBase)
}
