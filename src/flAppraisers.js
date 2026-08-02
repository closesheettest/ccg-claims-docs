// FL county → Property Appraiser property-search deep link. Mirrors the map the
// rep dashboard already uses (index.html window.COUNTIES) — each URL opens that
// county's search form, not the homepage. Key = lowercase county name, no "county".
export const FL_APPRAISERS = {
  "alachua": ["Alachua County", "https://qpublic.schneidercorp.com/Application.aspx?AppID=1081&LayerID=26567&PageTypeID=2&PageID=10808"],
  "bay": ["Bay County", "https://www.baycopa.net/"],
  "bradford": ["Bradford County", "https://bradfordpa.com/"],
  "brevard": ["Brevard County", "https://www.bcpao.us/PropertySearch/#/nav/Search"],
  "broward": ["Broward County", "https://bcpa.net/RecMenu.asp"],
  "charlotte": ["Charlotte County", "https://www.ccappraiser.com/RPSearchEnter.asp?"],
  "citrus": ["Citrus County", "https://www.citruspa.org/_web/search/commonsearch.aspx?mode=address"],
  "clay": ["Clay County", "https://www.ccpao.com/"],
  "collier": ["Collier County", "https://www.collierappraiser.com/"],
  "columbia": ["Columbia County", "https://www.columbiacountypa.net/"],
  "desoto": ["DeSoto County", "https://www.desotopafl.com/"],
  "duval": ["Duval County", "https://paopropertysearch.coj.net/Basic/Search.aspx"],
  "escambia": ["Escambia County", "https://www.escpa.org/"],
  "flagler": ["Flagler County", "https://www.flaglerpa.com/"],
  "hardee": ["Hardee County", "https://www.hardeepa.com/"],
  "hendry": ["Hendry County", "https://www.hendrypa.com/"],
  "hernando": ["Hernando County", "https://propsearch.hernandopa-fl.us"],
  "highlands": ["Highlands County", "https://www.hcpao.net/"],
  "hillsborough": ["Hillsborough County", "https://gis.hcpafl.org/propertysearch/#/nav/Basic%20Search"],
  "indian river": ["Indian River County", "https://qpublic.schneidercorp.com/Application.aspx?App=IndianRiverCountyFL&PageType=Search"],
  "jackson": ["Jackson County", "https://www.jacksoncountypa.com/"],
  "lake": ["Lake County", "https://www.lakecopropappr.com/"],
  "lee": ["Lee County", "https://www.leepa.org/Search/PropertySearch.aspx"],
  "leon": ["Leon County", "https://leonpa.gov/"],
  "levy": ["Levy County", "https://www.levypa.net/"],
  "manatee": ["Manatee County", "https://www.manateepao.gov/search/"],
  "marion": ["Marion County", "https://www.pa.marion.fl.us/PropertySearch.aspx"],
  "martin": ["Martin County", "https://www.pamartinfl.gov"],
  "miami-dade": ["Miami-Dade County", "https://apps.miamidadepa.gov/PropertySearch/#/"],
  "monroe": ["Monroe County", "https://www.mcpafl.org/"],
  "nassau": ["Nassau County", "https://www.nassauflpa.com/"],
  "okaloosa": ["Okaloosa County", "https://www.okaloosapa.com/"],
  "okeechobee": ["Okeechobee County", "https://www.okeechobeepa.com/"],
  "orange": ["Orange County", "https://ocpaweb.ocpafl.org/parcelsearch"],
  "osceola": ["Osceola County", "https://www.property-appraiser.org"],
  "palm beach": ["Palm Beach County", "https://pbcpao.gov/index.htm"],
  "pasco": ["Pasco County", "https://search.pascopa.com"],
  "pinellas": ["Pinellas County", "https://www.pcpao.gov/quick-search?qu=1"],
  "polk": ["Polk County", "https://www.polkflpa.gov/default.aspx?cookie_test=true"],
  "putnam": ["Putnam County", "https://qpublic.schneidercorp.com/Application.aspx?AppID=598&LayerID=9801&PageTypeID=2&PageID=4328"],
  "santa rosa": ["Santa Rosa County", "https://www.srcpa.org/"],
  "sarasota": ["Sarasota County", "https://www.sc-pa.com/propertysearch"],
  "seminole": ["Seminole County", "https://www.scpafl.org"],
  "st. johns": ["St. Johns County", "https://www.sjcpa.gov"],
  "st. lucie": ["St. Lucie County", "https://apps.paslc.gov/property-search/real-estate/basic-site-address"],
  "sumter": ["Sumter County", "https://www.sumterpa.com/"],
  "suwannee": ["Suwannee County", "https://www.suwanneepa.com/"],
  "volusia": ["Volusia County", "https://vcpa.vcgov.org"],
  "wakulla": ["Wakulla County", "https://www.wakullafl.gov/departments/property-appraiser"],
  "walton": ["Walton County", "https://www.waltoncountypa.com/"],
};

// Google returns the county as admin_area_level_2 ("Pasco County"); normalize to
// the map key ("pasco"). Handles "Saint"→"St." for the two St. counties.
export function appraiserFor(county) {
  if (!county) return null;
  let key = String(county).toLowerCase().replace(/\s+county$/, "").replace(/^saint /, "st. ").trim();
  return FL_APPRAISERS[key] || null;
}
