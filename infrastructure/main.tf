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
  name                = "pip-vm-${var.environment}-${count.index}"
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
  name                = "nic-vm-${var.environment}-${count.index}"
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
  name                = "nsg-vm-${var.environment}-${count.index}"
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
  name                = "vm-${var.environment}-${count.index}"
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
}
