export interface HassState {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed?: string;
  last_updated?: string;
}

export interface HassConnection {
  subscribeMessage<T>(callback: (message: T) => void, message: Record<string, any>, options?: Record<string, any>): Promise<() => void | Promise<void>>;
}

export interface Hass {
  states: Record<string, HassState>;
  user?: { id: string; name?: string; is_admin?: boolean };
  connection: HassConnection;
  callWS<T = any>(msg: Record<string, any>): Promise<T>;
  callService(domain: string, service: string, data?: Record<string, any>, target?: Record<string, any>): Promise<unknown>;
  formatEntityState?: (stateObj: HassState, state?: string) => string;
  locale?: { language?: string };
  language?: string;
}

/** Stato del microfono mostrato dal pulsante. */
export type MicState = "off" | "starting" | "on" | "denied" | "unavailable" | "error";
