export type HueScenes = { [sceneId: string]: HueScene };

export interface HueScene {
  name: string;
  /** ISO timestamp — used to pick the newest scene when names collide */
  lastupdated?: string;
  /** Light ids the scene covers — used by Show Scene On Group to pick
   *  the matching zone's scene when names collide across zones */
  lights?: string[];
}
