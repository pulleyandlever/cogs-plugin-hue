export type HueScenes = { [sceneId: string]: HueScene };

export interface HueScene {
  name: string;
  /** ISO timestamp — used to pick the newest scene when names collide */
  lastupdated?: string;
}
