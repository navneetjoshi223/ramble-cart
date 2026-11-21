export interface NormalizedPrice {
  amountMinor: number;
  currency: string;
  formatted: string;
}

export interface NormalizedMedia {
  url: string;
  altText: string;
  width: number | null;
  height: number | null;
}

export interface NormalizedSeller {
  id: string | null;
  name: string;
  url: string | null;
  domain: string | null;
}

export interface NormalizedOptionSelection {
  name: string;
  label: string;
}

export interface NormalizedProductOption {
  name: string;
  values: string[];
}

export interface NormalizedVariant {
  id: string;
  title: string;
  url: string | null;
  price: NormalizedPrice | null;
  available: boolean | null;
  selectedOptions: NormalizedOptionSelection[];
  seller: NormalizedSeller | null;
  media: NormalizedMedia[];
  condition: string | null;
}

export interface NormalizedProduct {
  id: string;
  title: string;
  handle: string | null;
  descriptionText: string;
  features: string[];
  rating: {
    value: number;
    scaleMax: number;
    count: number;
  } | null;
  media: NormalizedMedia[];
  options: NormalizedProductOption[];
  selectedOptions: NormalizedOptionSelection[];
  primaryVariant: NormalizedVariant | null;
  variants: NormalizedVariant[];
}

export interface NormalizedMessage {
  code: string;
  severity: "info" | "warning" | "error";
  text: string;
}

export interface SearchCatalogResult {
  query: string;
  country: string;
  currency: string;
  fetchedAt: string;
  products: NormalizedProduct[];
  messages: NormalizedMessage[];
  pagination: {
    hasNextPage: boolean;
    totalCount: number | null;
    cursor: string | null;
  };
}

export interface GetProductResult {
  fetchedAt: string;
  product: NormalizedProduct;
  messages: NormalizedMessage[];
}

export interface SpaceQueryInterpretation {
  searchQuery: string;
  maxPriceUsd: number | null;
  activeConstraints: Array<{
    text: string;
    kind: "required" | "preferred" | "excluded" | "spatial";
  }>;
  supersededConstraints: string[];
  sceneSummary: string;
}
