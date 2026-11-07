<div class="container">
    <div class="row" class="form-group">
        <div class="col-md-2">
            <label for="name">First / Last Name :</label>
            <input type="text" class="name" placeholder="Enter your name">
        </div>
        <div class="col-md-2">
            <label for="Address">Address :</label>
            <input type="text" class="form-control address1" id="Address1" placeholder="Enter your address">
        </div>
        <div class="col-md-2">
            <label for="city">City :</label>
            <input type="text" class="form-control city" id="Address1" placeholder="Enter your city">
        </div>
        <ul>
            <span class="required" style="color:red">
             <input type="checkbox" class="required" id="required" name="required" value="required">
        </ul>
    </div>
</div>
<script type="text/javascript">
$(function(){
   let name = $(".name").val();
});
</script>