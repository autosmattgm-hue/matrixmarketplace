const products = [
  {
    id: 1,
    title: "Wireless Headphones",
    description: "Noise cancelling over-ear headphones with deep bass.",
    price: 99.99,
    image: "matrixx.png"
  },
  {
    id: 2,
    title: "Smart Watch",
    description: "Fitness tracker with heart-rate monitor and GPS.",
    price: 149.99,
    image: "matrixx.png"
  },
  {
    id: 3,
    title: "Gaming Laptop",
    description: "High performance laptop for gaming and work.",
    price: 899.99,
    image: "matrixx.png"
  },
  {
    id: 4,
    title: "Sneakers",
    description: "Comfortable sports sneakers for everyday use.",
    price: 59.99,
    image: "matrixx.png"
  }
];
// ================= PRODUCT SYSTEM =================

// Add new product (for sellers)
function addProduct() {
  const name = document.getElementById("productName").value;
  const price = parseFloat(document.getElementById("productPrice").value);
  const image = document.getElementById("productImage").value;
  const desc = document.getElementById("productDesc").value;
  const location = document.getElementById("productLocation").value;
  const seller = JSON.parse(MMStorage.getItem("currentUser"))?.name || "Unknown Seller";

  if (!name || !price || !image) {
    return alert("⚠ Please fill in all required fields!");
  }

  let products = JSON.parse(MMStorage.getItem("products")) || [];

  let newProduct = {
    id: Date.now(),
    name,
    price,
    image,
    desc,
    location,
    seller,
  };

  products.push(newProduct);
  MMStorage.setItem("products", JSON.stringify(products));

  alert("✅ Product added successfully!");
  window.location.href = "shop.html"; // redirect to shop after upload
}

// Load products (for shop.html & index.html)
function loadProducts(containerId = "productList") {
  let products = JSON.parse(MMStorage.getItem("products")) || [];
  let container = document.getElementById(containerId);

  if (!container) return;
  container.innerHTML = "";

  if (products.length === 0) {
    container.innerHTML = "<p>No products available yet.</p>";
    return;
  }

  products.forEach((p) => {
    let div = document.createElement("div");
    div.classList.add("product-card");
    div.innerHTML = `
      <img loading="lazy" decoding="async" fetchpriority="low" src="${p.image}" alt="${p.name}" style="width:100%;border-radius:10px;">
      <h3>${p.name}</h3>
      <p>${p.price} GMD</p>
      <p>${p.desc || ""}</p>
      <p><strong>Location:</strong> ${p.location || "N/A"}</p>
      <p><em>Seller: ${p.seller}</em></p>
      <button onclick="addToCart(${p.id})">🛒 Add to Cart</button>
      <button onclick="payNow('${p.name}', ${p.price})">💳 Buy Now</button>
    `;
    container.appendChild(div);
  });
}

// Seller’s own products (for dashboard)
function loadSellerProducts(containerId = "sellerProducts") {
  let products = JSON.parse(MMStorage.getItem("products")) || [];
  let user = JSON.parse(MMStorage.getItem("currentUser"));
  if (!user) return;

  let sellerProducts = products.filter(p => p.seller === user.name);
  let container = document.getElementById(containerId);

  if (!container) return;
  container.innerHTML = "";

  if (sellerProducts.length === 0) {
    container.innerHTML = "<p>You haven’t uploaded any products yet.</p>";
    return;
  }

  sellerProducts.forEach((p, idx) => {
    let div = document.createElement("div");
    div.classList.add("product-card");
    div.innerHTML = `
      <img loading="lazy" decoding="async" fetchpriority="low" src="${p.image}" alt="${p.name}" style="width:100%;border-radius:10px;">
      <h3>${p.name}</h3>
      <p>${p.price} GMD</p>
      <p>${p.desc || ""}</p>
      <button onclick="deleteProduct(${p.id})">🗑 Delete</button>
    `;
    container.appendChild(div);
  });
}

// Delete product
function deleteProduct(id) {
  let products = JSON.parse(MMStorage.getItem("products")) || [];
  products = products.filter(p => p.id !== id);
  MMStorage.setItem("products", JSON.stringify(products));
  alert("🗑 Product deleted!");
  loadSellerProducts(); // refresh seller dashboard
}

// Auto-load if container exists
window.onload = function () {
  if (document.getElementById("productList")) loadProducts("productList");
  if (document.getElementById("sellerProducts")) loadSellerProducts("sellerProducts");
};

