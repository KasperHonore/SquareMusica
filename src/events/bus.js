import { EventEmitter } from 'events';

// Single shared event bus for cross-module communication. Defined in its own
// module (not in a transport) so that core/ and transports/ can both depend on
// it without forming a cross-layer import cycle.
export const botEvents = new EventEmitter();
