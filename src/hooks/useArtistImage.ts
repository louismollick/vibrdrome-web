import { useState, useEffect, useRef } from 'react';
import { resolveArtistImage, type ArtistImageResult } from '../utils/artistImageResolver';

const EMPTY: ArtistImageResult = { imageUrl: null, artistId: null, coverArt: null };

export function useArtistImage(artistName: string | undefined): ArtistImageResult {
  const [result, setResult] = useState<ArtistImageResult>(EMPTY);
  const nameRef = useRef(artistName);

  useEffect(() => {
    nameRef.current = artistName;
    if (!artistName) return;

    resolveArtistImage(artistName).then((res) => {
      if (nameRef.current === artistName) {
        setResult(res);
      }
    });
  }, [artistName]);

  return result;
}
