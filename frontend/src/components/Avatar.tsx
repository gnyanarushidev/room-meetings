import type { CSSProperties } from 'react'
import type { Profile } from '../types'

const colors = [
  ['#352b4d', '#d7c7f5'], ['#263d40', '#b4dcdf'], ['#44352b', '#ebc9ad'],
  ['#29364f', '#bdcff1'], ['#432d3c', '#ebbed7'], ['#303e2c', '#c6ddb9'],
]

export default function Avatar({ user, small = false }: { user: Profile; small?: boolean }) {
  const hash = [...user.id].reduce((value, letter) => value + letter.charCodeAt(0), 0)
  const [background, color] = colors[hash % colors.length]
  const initials = user.name.trim().split(/\s+/).slice(0, 2).map(part => [...part][0]).join('').toUpperCase()
  return <span className={`avatar ${small ? 'avatar-small' : ''}`} style={{ background, color } as CSSProperties} title={user.name}>{initials}</span>
}
