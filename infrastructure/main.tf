resource "azurerm_resource_group" "main" {
  name     = "rg-${var.application_name}-${var.environment}"
  location = var.primary_region

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}

resource "azurerm_virtual_network" "main" {
  name                = "vnet-${var.application_name}-${var.environment}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = ["10.0.0.0/16"]

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}

resource "azurerm_subnet" "main" {
  name                 = "snet-${var.application_name}-${var.environment}"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.0.0/16"]
}


resource "azurerm_public_ip" "pip" {
  count               = var.vm_count
  name                = "pip-vm-${var.environment}-${count.index + 1}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  allocation_method   = "Static"

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}

resource "azurerm_network_interface" "nic" {
  count               = var.vm_count
  name                = "nic-vm-${var.environment}-${count.index + 1}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.main.id
    private_ip_address_allocation = "Static"
    private_ip_address            = "10.0.10.${count.index + 10}"
    public_ip_address_id          = azurerm_public_ip.pip[count.index].id
  }

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}


resource "azurerm_network_security_group" "nsg" {
  count               = var.vm_count
  name                = "nsg-vm-${var.environment}-${count.index + 1}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  security_rule {
    name                       = "allowSSHInbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "allowInboundToBackend"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8000"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}

resource "azurerm_network_interface_security_group_association" "nic-nsg-assoc" {
  count                     = var.vm_count
  network_interface_id      = azurerm_network_interface.nic[count.index].id
  network_security_group_id = azurerm_network_security_group.nsg[count.index].id
}

resource "azurerm_linux_virtual_machine" "vm" {
  count               = var.vm_count
  name                = "vm-${var.environment}-${count.index + 1}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  size                = var.vm_size
  admin_username      = "vmadmin"
  network_interface_ids = [
    azurerm_network_interface.nic[count.index].id,
  ]

  admin_ssh_key {
    username   = "vmadmin"
    public_key = var.public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts"
    version   = "latest"
  }

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}

resource "azurerm_storage_account" "datalake" {
  name                     = "st${var.application_name}${var.environment}"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}


resource "azurerm_static_web_app" "frontend" {
  name                = "swa-${var.application_name}-${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  location            = "westeurope"
  sku_tier            = "Free"
  sku_size            = "Free"

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}

resource "azurerm_postgresql_flexible_server" "postgres" {
  name                   = "psql-${var.application_name}-${var.environment}"
  resource_group_name    = azurerm_resource_group.main.name
  location               = azurerm_resource_group.main.location
  version                = "16"
  administrator_login    = "psqladmin"
  administrator_password = var.db_admin_password
  zone                   = "3"

  storage_mb   = 32768 # 32GB is the default for B1ms free tier
  storage_tier = "P4"
  sku_name     = "B_Standard_B1ms"

  # Allow public access so the Azure Function can connect to it (needed for the free tier)
  public_network_access_enabled = true

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}

# Firewall rule 1: For testing, this allows any IP to reach the DB. 
resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_all" {
  name             = "AllowAll_Test_Only"
  server_id        = azurerm_postgresql_flexible_server.postgres.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "255.255.255.255"
}

# Firewall rule 2: Allows the Azure Function to reach the database
resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_azure" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.postgres.id
  start_ip_address = "0.0.0.0" # In Azure PG, 0.0.0.0 to 0.0.0.0 means "Allow Azure internal traffic"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_postgresql_flexible_server_database" "metadata_db" {
  name      = "satellite_metadata"
  server_id = azurerm_postgresql_flexible_server.postgres.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}


resource "azurerm_service_plan" "func_plan" {
  name                = "asp-${var.application_name}-${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "Y1" # Y1 is the Free Plan

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}

resource "azurerm_linux_function_app" "ingestion_func" {
  name                = "func-${var.application_name}-${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  service_plan_id     = azurerm_service_plan.func_plan.id

  storage_account_name       = azurerm_storage_account.datalake.name
  storage_account_access_key = azurerm_storage_account.datalake.primary_access_key

  site_config {
    application_stack {
      python_version = "3.11"
    }
    cors {
      allowed_origins = ["*"]
    }
  }

  app_settings = {
    "POSTGRES_CONNECTION_STRING" = "postgresql://psqladmin:${var.db_admin_password}@${azurerm_postgresql_flexible_server.postgres.fqdn}:5432/satellite_metadata"
    "CDSE_CLIENT_ID"             = "${var.copernicus_client_id}"
    "CDSE_CLIENT_SECRET"         = "${var.copernicus_client_secret}"
  }

  tags = {
    Created_By  = "Terraform"
    environment = "${var.environment}"
  }
}
