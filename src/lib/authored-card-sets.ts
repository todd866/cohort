import type {GeneratedCard} from './card-generator';
/** Private typed card sets are absent from the public corpus. */
export function authoredCardSet(key:unknown,_rotation:string,_sourceFile:string):GeneratedCard[] { if(key!==undefined)throw new Error('Private card set is unavailable'); return []; }
