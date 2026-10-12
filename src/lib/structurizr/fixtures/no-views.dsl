// A workspace with NO views block — the importer must synthesise a sensible set
// of diagrams (landscape + per-system containers + per-container components).
workspace "Shop" "An online shop" {
    model {
        customer = person "Customer"
        admin = person "Admin"

        shop = softwareSystem "Shop" {
            storefront = container "Storefront" "Customer web UI" "Next.js"
            backend = container "Backend API" "Business logic" "Go"
            db = container "Orders DB" "Stores orders" "PostgreSQL"
            queue = container "Event Queue" "Async events" "Kafka"
        }

        payments = softwareSystem "Payments" "Third-party payments" "External"
        warehouse = softwareSystem "Warehouse" "Fulfilment system"

        customer -> storefront "Browses & buys"
        admin -> backend "Manages catalogue"
        storefront -> backend "Calls" "JSON/HTTPS"
        backend -> db "Reads/writes" "SQL"
        backend -> queue "Publishes events"
        backend -> payments "Charges card" "HTTPS"
        queue -> warehouse "Notifies"
    }
}
