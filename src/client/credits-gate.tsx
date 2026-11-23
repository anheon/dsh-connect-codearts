import { useSyncExternalStore } from 'react'
import { ComposerCredits } from './ComposerCredits.tsx'
import type { CodeArtsCardInjected } from './CodeArtsCard.tsx'

interface ModelDirectorySnapshot {
  readonly current: { readonly provider: string } | null
  readonly routable: boolean | null
}

export interface ModelDirectoryStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): ModelDirectorySnapshot
}

export const shouldShowCredits = ({ current, routable }: ModelDirectorySnapshot): boolean =>
  routable !== false && current?.provider === 'codearts'

export interface CreditsGateProps extends CodeArtsCardInjected {
  readonly directory: ModelDirectoryStore
}

/** Read the same effective model as DSH's composer, including its initial default. */
export const CreditsGate = ({ directory, ...injected }: CreditsGateProps): React.ReactElement | null => {
  const model = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot)
  return shouldShowCredits(model) ? <ComposerCredits {...injected} /> : null
}
