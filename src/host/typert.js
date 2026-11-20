import { PACKAGE_NAME, descriptors } from '../shared/wire.js'

export const TYPERT = Object.freeze({
  package: PACKAGE_NAME,
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: descriptors,
})
