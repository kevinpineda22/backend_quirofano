export const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
export const LIQUIDATION_ID = "22222222-2222-4222-8222-222222222222";
export const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
export const INVOICE_ID = "44444444-4444-4444-8444-444444444444";
export const taxes = [{ id: 1, name: "IVA 19%", type: "IVA", percentage: 19 }];
export const product = {
  id: PRODUCT_ID, code: "ABC", name: "Producto prueba", type: "Product", active: true,
  account_group: { id: 100, name: "Abarrotes" }, tax_classification: "Taxed",
  tax_included: true, taxes: [{ id: 1, percentage: 19 }], unit: { code: "94", name: "Unidad" },
  prices: [
    { currency_code: "COP", price_list: [{ position: 1, name: "General", value: 11900 }, { position: 2, name: "Mayorista", value: 11000 }] },
    { currency_code: "USD", price_list: [{ position: 1, value: 3 }] },
  ],
};
export const storedProduct = {
  id: PRODUCT_ID, code: "ABC", name: product.name, category: "Abarrotes", active: true,
  tax_rate: 19, tax_error: null, purchase_cost: 7000, cost_date: "2026-11-16", payload: product,
};
export const invoice = {
  id: INVOICE_ID, date: "2026-11-17", tax_included: true, total: 21420,
  supplier: { identification: "900123", name: ["Proveedor", "Prueba"] },
  items: [{ type: "Product", code: "ABC", description: "Producto prueba", quantity: 2,
    price: 11900, discount: { value: 2380 }, taxes: [{ id: 1 }] }],
};
