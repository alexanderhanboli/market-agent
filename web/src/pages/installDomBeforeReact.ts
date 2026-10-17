// Imported first by tests that type into inputs: react-dom checks for a DOM
// once, at load time, and without one it routes onChange through a fallback
// that jsdom events do not drive.
import { JSDOM } from 'jsdom'

const { window } = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, { window, document: window.document })
