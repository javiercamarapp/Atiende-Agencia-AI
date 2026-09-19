export type { LockStore, AcquireLockOptions, AcquireLockResult } from './lock/types.ts';
export { lockKey } from './lock/types.ts';
export { InMemoryLockStore } from './lock/in-memory-lock-store.ts';
export { RedisLockStore, type RedisLockStoreOptions } from './lock/redis-lock-store.ts';

export type { StateStore, StoredConversationState } from './state/types.ts';
export {
  ConversationStateEnum,
  DEFAULT_BOOKING_TRANSITIONS,
  isValidTransition,
  type BookingState,
  type TransitionTable,
} from './state/transitions.ts';
export { InMemoryStateStore } from './state/in-memory-state-store.ts';
export {
  ConversationStateMachine,
  type TransitionOutcome,
  type ConversationStateMachineOptions,
} from './state/state-machine.ts';

export { buildStatePromptBlock } from './prompt-context.ts';
export { withConversationLock, type ConversationGuardResult } from './guard.ts';
