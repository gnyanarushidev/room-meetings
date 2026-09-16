import type { CSSProperties } from 'react'
import type { Profile } from '../types'

const colors = [
  ['#7c3aed', '#ffffff'], ['#22d3ee', '#07121e'], ['#fb923c', '#261206'],
  ['#2563eb', '#ffffff'], ['#ff70b7', '#28122a'], ['#a3e635', '#122006'],
]

export default function Avatar({ user, small = false }: { user: Profile; small?: boolean }) {
  const hash = [...user.id].reduce((value, letter) => value + letter.charCodeAt(0), 0)
  const [background, color] = colors[hash % colors.length]
  const initials = user.name.trim().split(/\s+/).slice(0, 2).map(part => [...part][0]).join('').toUpperCase()
  return <span className={`avatar ${small ? 'avatar-small' : ''}`} style={{ background, color } as CSSProperties} title={user.name}>{initials}</span>
}
