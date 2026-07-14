import type { SendAction } from './types'

export function sendReducer(_state: boolean, action: SendAction): boolean {
  return action.type === 'SEND_START'
}
