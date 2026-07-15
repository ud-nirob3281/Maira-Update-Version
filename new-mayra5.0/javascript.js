document.querySelector('form').addEventListener('submit', function(e) {
    e.preventDefault();
    const name = document.getElementById('name').value;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    const formObject = {
        name: name,
        email: email,
        password: password
    };

    console.log(formObject);
});