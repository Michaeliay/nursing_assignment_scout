import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function searchAIProducts(customQuery?: string) {
  const defaultQuery = "Search for the latest AI products and technologies that automate or optimize nursing zone assignments (also known as patient assignment nursing math or nursing workload balancing). Provide a detailed summary of developments over the past week and a list of specific products with their website links.";
  const query = customQuery ? `${defaultQuery} Specifically focus on: ${customQuery}` : defaultQuery;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: query,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    return response.text;
  } catch (error) {
    console.error("Gemini search failed:", error);
    throw error;
  }
}

export async function summarizeDigest(searchRaw: string, previouslySeen: string[]) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Summarize the following search results about AI nursing zone assignment products into a clean, professional weekly digest. 
      
      CRITICAL: You must categorize products based on this list of previously seen titles: [${previouslySeen.join(', ')}].
      If a product from the search results is NOT in the provided list, categorize it as NEW.
      If it IS in the list, categorize it as PREVIOUS.

      Return a JSON object with exactly these keys:
      - "summary": A detailed markdown string covering weekly trends and high-level insights.
      - "newProducts": An array of objects each having "title", "url", and "description" (short markdown).
      - "existingProducts": An array of objects each having "title" and "url".
      
      Search Results:
      ${searchRaw}`,
      config: {
        responseMimeType: "application/json"
      }
    });

    const result = JSON.parse(response.text);
    return {
      summary: result.summary || "No summary generated.",
      newProducts: Array.isArray(result.newProducts) ? result.newProducts : [],
      existingProducts: Array.isArray(result.existingProducts) ? result.existingProducts : []
    };
  } catch (error) {
    console.error("Gemini summarization failed:", error);
    throw error;
  }
}
